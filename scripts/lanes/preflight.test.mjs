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
import { readChecksShard, readTestTimeout, parseDiff, planSteps, gitRepo, namedPaths, REPO_ROOT, VITEST_PACKAGES, GUARD_TESTS,
  PLAN_SECS, MAX_EXTRA } from './preflight-plan.mjs';

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
  assert.match(s.cmd, /^TEST_ALL_TIMEOUT_MS=30000 pnpm --filter @beanpool\/pwa exec vitest run --maxWorkers=2 --passWithNoTests /);
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
const TEST_ALL_EXPORT = 'export TEST_ALL_TIMEOUT_MS="${TEST_ALL_TIMEOUT_MS:-30000}"';
function fakeRepo(files, testAllText = TEST_ALL_EXPORT) {
  return {
    ciYml: real.ciYml,
    testAllText,
    tests: dir => Object.keys(files).filter(f => f.startsWith(dir + '/') && /\.test\.\w+$/.test(f)),
    files: dir => Object.keys(files).filter(f => f.startsWith(dir + '/')),
    read: f => files[f] ?? '',
    exists: f => f in files,
  };
}
const filesOf = s => (s.cmd.split('--passWithNoTests ')[1] || '').split(' ').filter(Boolean);
const total = steps => steps.reduce((n, s) => n + s.est, 0);

// ── the time budget (Opus review of #3180: phone PRs planned 150-280 native files and overran the 600 s Bash call) ──

test('every step carries a whole-second estimate, and the plan\'s sum stays under the plan budget', () => {
  const steps = plan({ 'apps/native/components/BeansText.tsx': 'x', 'apps/server/src/db/schema.sql': 'x',
    'apps/server/src/routes/forum.ts': "router.get('/api/x', h);" });
  for (const s of steps) assert.ok(Number.isInteger(s.est) && s.est > 0, `${s.name} has an estimate (${s.est})`);
  assert.ok(total(steps) <= PLAN_SECS, `${total(steps)} s <= ${PLAN_SECS} s`);
});

/** A phone package with many pins, importers and scanners of utils/db.ts, plus the guard. */
function bigPhone({ pins = 80, importers = 300, scanners = 100 } = {}) {
  const files = { 'apps/native/utils/db.ts': '', 'apps/native/utils/__tests__/dark-mode-sources.test.ts': 'readdirSync(x)' };
  for (let i = 0; i < pins; i++) files[`apps/native/utils/__tests__/pin${String(i).padStart(3, '0')}.test.ts`] = "read('utils/db.ts')";
  for (let i = 0; i < importers; i++) files[`apps/native/utils/__tests__/imp${i}.test.ts`] = "import { x } from '../db';";
  for (let i = 0; i < scanners; i++) files[`apps/native/utils/__tests__/scan${i}.test.ts`] = 'fs.readdirSync(dir)';
  return files;
}

test('a big phone PR runs the guard, the changed tests and at most MAX_EXTRA more, not hundreds of files', () => {
  const files = bigPhone();
  files['apps/native/utils/__tests__/mine.test.ts'] = 'it()';
  const s = step(plan({ 'apps/native/utils/db.ts': 'x', 'apps/native/utils/__tests__/mine.test.ts': 'it()' }, fakeRepo(files)),
    'vitest:beanpool-pillar');
  const run = filesOf(s);
  assert.equal(run.length, 1 + 1 + MAX_EXTRA, `guard + changed test + ${MAX_EXTRA}: ${run.length}`);
  assert.ok(run.includes('utils/__tests__/dark-mode-sources.test.ts'), 'the guard runs');
  assert.ok(run.includes('utils/__tests__/mine.test.ts'), 'the changed test runs');
  assert.equal(run.filter(f => /\/pin\d+/.test(f)).length, MAX_EXTRA, 'pins fill the cap before importers and scanners');
  assert.match(s.why, /left to CI \(past 60 a package or the 330 s plan budget\): 20 pins, 300 importers, 100 scanners/);
});

test('the plan budget holds across packages: importers past it are left to CI, guards run whatever the budget', () => {
  const files = bigPhone({ pins: 0, importers: 50, scanners: 0 });
  files['apps/pwa/src/api.ts'] = '';
  for (const g of GUARD_TESTS.filter(t => t.startsWith('apps/pwa/'))) files[g] = 'readdirSync(x)';
  for (let i = 0; i < 50; i++) files[`apps/pwa/src/imp${i}.test.ts`] = "import { x } from './api';";
  const touched = { 'apps/native/utils/db.ts': 'x', 'apps/pwa/src/api.ts': 'x' };
  const steps = planSteps(parseDiff(diff(touched)), fakeRepo(files), { planSecs: 170 });
  assert.ok(total(steps) <= 170, `${total(steps)} s <= 170 s`);
  assert.ok(total(steps) >= 165, `the budget is used, not wasted: ${total(steps)} s`);
  const left = steps.filter(s => s.name.startsWith('vitest:')).reduce((n, s) => n + s.left, 0);
  const ran = steps.filter(s => s.name.startsWith('vitest:')).reduce((n, s) => n + s.files, 0);
  assert.equal(ran + left, 1 + 4 + 50 + 50, 'every test is either run or counted as left to CI');
  assert.ok(left > 0, `${left} importers left to CI`);
  assert.equal(filesOf(step(steps, 'vitest:@beanpool/pwa')).length >= 4, true, 'the 4 web guards');
  const tiny = planSteps(parseDiff(diff(touched)), fakeRepo(files), { planSecs: 1 });
  assert.deepEqual(filesOf(step(tiny, 'vitest:@beanpool/pwa')), GUARD_TESTS.filter(t => t.startsWith('apps/pwa/'))
    .map(t => t.slice('apps/pwa/'.length)).sort(), 'only the guards when nothing else fits');
  assert.match(step(tiny, 'vitest:beanpool-pillar').why, /left to CI .*: 50 importers/);
});

test('MUTANT: with no cap and no budget the big phone plan is the 380 files the review measured, so the tests above can fail', () => {
  const s = step(planSteps(parseDiff(diff({ 'apps/native/utils/db.ts': 'x' })), fakeRepo(bigPhone()), { planSecs: 1e9, maxExtra: 1e9 }),
    'vitest:beanpool-pillar');
  assert.equal(filesOf(s).length, 1 + 80 + 300 + 100);
});

test('the real tree: a phone PR the size of #3113 (20 sources) plans under the budget and at most guard + MAX_EXTRA phone files', () => {
  const sources = ['utils/db.ts', 'app/welcome.tsx', 'app/(tabs)/settings.tsx', 'app/(tabs)/index.tsx', 'app/(tabs)/_layout.tsx',
    'components/NeedsYouIcons.tsx', 'components/home/HomeCardBodies.tsx', 'components/OneWayBackCard.tsx', 'utils/one-way-back.ts',
    'utils/home-cards.ts', 'utils/home-store.ts', 'utils/notification-permission.ts', 'utils/tour-store.ts', 'components/TourBar.tsx',
    'utils/storage-keys.ts', 'components/home/ArrangeParts.tsx', 'components/NotificationPermissionCard.tsx',
    'components/NotificationsOffLine.tsx', 'components/RecoveryKitButtons.tsx', 'utils/words-kept.ts'];
  const steps = plan(Object.fromEntries(sources.map(f => [`apps/native/${f}`, 'x'])));
  const s = step(steps, 'vitest:beanpool-pillar');
  assert.ok(filesOf(s).length <= 1 + MAX_EXTRA, `${filesOf(s).length} phone files`);
  assert.ok(total(steps) <= PLAN_SECS, `${total(steps)} s`);
});

// ── pins by the real path, not the file name ──

test('a pin names the touched file by its real path: app/(tabs)/_layout.tsx is not app/_layout.tsx, and prose is no pin', () => {
  const files = {
    'apps/native/app/_layout.tsx': '', 'apps/native/app/(tabs)/_layout.tsx': '', 'apps/native/components/Card.tsx': '',
    'apps/native/utils/__tests__/tabs.test.ts': "readFileSync(path.resolve(__dirname, '../../app/(tabs)/_layout.tsx'))",
    'apps/native/utils/__tests__/root.test.ts': "readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'))",
    'apps/native/utils/__tests__/pkgrel.test.ts': "const src = read('app/(tabs)/_layout.tsx');",
    'apps/native/utils/__tests__/prose.test.ts': '// the tab bar (app/(tabs)/_layout.tsx) draws this',
    'apps/native/utils/__tests__/render.test.ts': "import TabLayout from '../../app/(tabs)/_layout';",
    'apps/native/components/__tests__/card.test.ts': "readFileSync(resolve(__dirname, '..', 'x')); read('Card.tsx')",
  };
  const s = step(plan({ 'apps/native/app/(tabs)/_layout.tsx': 'x' }, fakeRepo(files)), 'vitest:beanpool-pillar');
  assert.deepEqual(filesOf(s), ['utils/__tests__/pkgrel.test.ts', 'utils/__tests__/render.test.ts', 'utils/__tests__/tabs.test.ts'],
    'the two reads of its path and the import; not the root layout\'s test, not the comment');
  assert.match(s.why, /2 pins\/co-located, 1 importers/);
  // A bare quoted name counts when it is the only source file of that name in the package.
  const c = step(plan({ 'apps/native/components/Card.tsx': 'x' }, fakeRepo(files)), 'vitest:beanpool-pillar');
  assert.deepEqual(filesOf(c), ['components/__tests__/card.test.ts']);
});

test('a tree scanner that imports a touched file ranks with the importers, ahead of the other scanners', () => {
  const files = { 'apps/manager/src/api.ts': '', 'apps/manager/src/a-scan.test.ts': 'fs.readdirSync(dir)',
    'apps/manager/src/z-scan-imports.test.ts': "import { x } from './api'; fs.readdirSync(dir)" };
  const s = step(planSteps(parseDiff(diff({ 'apps/manager/src/api.ts': 'x' })), fakeRepo(files), { maxExtra: 1 }), 'vitest:@beanpool/manager');
  assert.deepEqual(filesOf(s), ['src/z-scan-imports.test.ts']);
  assert.match(s.why, /1 importers, 0 tree scanners; left to CI .*: 1 scanners/);
});

test('namedPaths resolves from the test\'s folder, the package root and an @/ alias; a bare name only when unique', () => {
  const t = 'apps/native/utils/__tests__/x.test.ts';
  const n = namedPaths("read('../db.ts'); import a from '@/components/A'; read('app/welcome.tsx'); read('_layout.tsx')", t, 'apps/native',
    new Map([['welcome.tsx', 'apps/native/app/welcome.tsx']]));
  assert.ok(n.withExt.has('apps/native/utils/db'));
  assert.ok(n.noExt.has('apps/native/components/A'));
  assert.ok(n.withExt.has('apps/native/app/welcome'));
  assert.ok(!n.withExt.has('apps/native/app/_layout'), 'a bare _layout.tsx names no particular layout');
  assert.ok(!namedPaths('// see utils/db.ts', t, 'apps/native').withExt.has('apps/native/utils/db'), 'a path in a comment');
});

test('the real tree: app/(tabs)/_layout.tsx pins a handful of tests, not the 50 that name any _layout.tsx', () => {
  const s = step(plan({ 'apps/native/app/(tabs)/_layout.tsx': 'x' }), 'vitest:beanpool-pillar');
  const pins = Number(s.why.match(/(\d+) pins\/co-located/)[1]);
  assert.ok(pins >= 1 && pins <= 15, `${pins} pins`);
  assert.ok(!filesOf(s).includes('utils/__tests__/recovery-kit.test.ts'), 'recovery-kit reads app/_layout.tsx, not the tab layout');
});

// ── guards: the tests that caught first-round reds ──

test('every guard test is a real file (a rename would drop it silently)', () => {
  for (const g of GUARD_TESTS) assert.ok(real.exists(g), `${g} exists`);
  assert.ok(GUARD_TESTS.every(g => VITEST_PACKAGES.some(p => g.startsWith(p.dir + '/'))), 'each guard is in a vitest package');
});

// ── the vitest time-out: CI's, read from test-all.sh ──

test('every vitest step carries test-all.sh\'s TEST_ALL_TIMEOUT_MS (core, engine, signin included)', () => {
  const touched = Object.fromEntries(VITEST_PACKAGES.map(p => [`${p.dir}/src/preflight-probe.ts`, 'x']));
  const files = Object.fromEntries(VITEST_PACKAGES.map(p => [`${p.dir}/src/preflight-probe.test.ts`, "import { x } from './preflight-probe';"]));
  const steps = plan(touched, fakeRepo(files)).filter(s => s.name.startsWith('vitest:'));
  assert.equal(steps.length, VITEST_PACKAGES.length, 'one vitest step per package');
  for (const s of steps) assert.ok(s.cmd.startsWith('TEST_ALL_TIMEOUT_MS=30000 pnpm '), `${s.name}: ${s.cmd.slice(0, 60)}`);
  assert.equal(readTestTimeout(real.testAllText), '30000', 'test-all.sh still gives 30 s');
});

test('the time-out is read from test-all.sh, never copied: a new value follows it, and none means no plan', () => {
  const steps = plan({ 'packages/beanpool-core/src/a.ts': 'x' },
    fakeRepo({ 'packages/beanpool-core/src/a.test.ts': "import { a } from './a';" }, TEST_ALL_EXPORT.replace('30000', '45000')));
  assert.ok(step(steps, 'vitest:@beanpool/core').cmd.startsWith('TEST_ALL_TIMEOUT_MS=45000 '));
  assert.throws(() => plan({}, fakeRepo({}, '# no export')), /exports no TEST_ALL_TIMEOUT_MS/);
});

test('a guide page adds no step (its tests take 5 min: CI runs them); a script runs its sibling test unless test-all does', () => {
  assert.deepEqual(names(plan({ 'packages/beanpool-guide/content/en/joining.md': 'A new sentence.' })), ['checks', 'words']);
  const repo = fakeRepo({ 'scripts/foo.mjs': '', 'scripts/foo.test.mjs': '', 'scripts/bar.mjs': '', 'scripts/bar.test.mjs': '' },
    `${TEST_ALL_EXPORT}\nrun_check "bar" node --test scripts/bar.test.mjs`);
  const steps = plan({ 'scripts/foo.mjs': 'x', 'scripts/bar.mjs': 'y' }, repo);
  assert.equal(step(steps, 'script-tests').cmd, 'node --test scripts/foo.test.mjs');
});

// ── the runner ──

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function tmpdir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-')); made.push(d); return d; }
/** A plan file: rows of [name, why, command] (estimate 1 s) or [name, est, why, command]. */
function planFile(dir, rows) {
  const f = path.join(dir, 'plan.tsv');
  fs.writeFileSync(f, rows.map(r => (r.length === 3 ? [r[0], '1', r[1], r[2]] : r).join('\t')).join('\n') + '\n');
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

test('a red test-all step names the failed check even when it is far above the last 40 lines', () => {
  const d = tmpdir();
  const r = run(planFile(d, [['checks', 'shard',
    'echo "║  no_google_fonts  ❌ FAIL  1s"; for i in $(seq 1 80); do echo "filler $i"; done; exit 1']]));
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /failed:\n║  no_google_fonts  ❌ FAIL/);
  assert.match(r.out, /filler 80/);
  assert.doesNotMatch(r.out, /filler 40\n/, 'only the tail of the filler');
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
  assert.match(r.out, /one\s+1s  first/);
  assert.ok(!fs.existsSync(`${d}/ran`));
});

test('a plan line with no command is red, never a pass that ran nothing', () => {
  const d = tmpdir();
  const f = path.join(d, 'plan.tsv');
  fs.writeFileSync(f, 'lonely\t\t\n');
  const r = run(f);
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /^FAIL  lonely/m);
});

test('a plan line whose estimate is not whole seconds is red, never a free step', () => {
  const d = tmpdir();
  const r = run(planFile(d, [['odd', 'soon', 'why', `touch ${d}/ran`]]));
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /^FAIL  odd/m);
  assert.ok(!fs.existsSync(`${d}/ran`));
  // Also as a later step, once time has passed: red, not a time stop (75) that reads as "run it again".
  const later = run(planFile(d, [['one', '1', 'first', 'sleep 1'], ['odd', 'soon', 'why', `touch ${d}/ran`]]));
  assert.equal(later.rc, 1, later.out);
  assert.match(later.out, /^FAIL  odd/m);
});

test('a step whose estimate would end past the hard limit is not started: exit 75, named, the steps before it ran', () => {
  const d = tmpdir();
  // Step two alone (3 s) fits the 4 s limit; after step one's 2 s it does not: the time already spent counts.
  const rows = [['one', '1', 'first', `sleep 2; touch ${d}/one-ran`], ['two', '3', 'second', `touch ${d}/two-ran`]];
  const r = run(planFile(d, rows), { PREFLIGHT_HARD_SECS: '4' });
  assert.equal(r.rc, 75, r.out);
  assert.match(r.out, /^TIME  step 2 \(two, about 3s\) would end past 4s at [2-9]s in/m);
  assert.match(r.out, /1 of 2 steps passed .* 1 NOT RUN/);
  assert.ok(fs.existsSync(`${d}/one-ran`));
  assert.ok(!fs.existsSync(`${d}/two-ran`));
  // A red before the stop still reads as red.
  const red = run(planFile(d, [['bad', '1', 'red', 'exit 3'], ['two', '5', 'second', 'true']]), { PREFLIGHT_HARD_SECS: '4' });
  assert.equal(red.rc, 1, red.out);
  assert.match(red.out, /1 of 1 steps RED .*not run: step 2/);
});

test('MUTANT: a runner without the hard-limit check starts the late step, so the test above can fail', () => {
  const d = tmpdir();
  const src = fs.readFileSync(RUNNER, 'utf8');
  const check = 'if [ $((elapsed + est)) -gt "$HARD" ]; then';
  assert.ok(src.includes(check), 'the line this mutant changes is in the runner');
  fs.mkdirSync(path.join(d, 'scripts/lanes'), { recursive: true });
  const mutant = path.join(d, 'scripts/lanes/preflight.sh');
  fs.writeFileSync(mutant, src.replace(check, 'if false; then'));
  const r = run(planFile(d, [['one', '1', 'first', 'true'], ['two', '5', 'second', `touch ${d}/two-ran`]]),
    { PREFLIGHT_HARD_SECS: '4' }, mutant);
  assert.equal(r.rc, 0, r.out);
  assert.ok(fs.existsSync(`${d}/two-ran`), 'the mutant ran the step that would end past the limit');
});

test('the lock gets what the 480 s budget leaves after the plan\'s estimate, at least 60 s; --plan says so', () => {
  const d = tmpdir();
  const lockOf = rows => run(planFile(d, rows), {}, RUNNER, ['--plan']).out.match(/the lock may take (\d+)s more/)[1];
  assert.equal(lockOf([['a', '100', 'x', 'true'], ['b', '30', 'y', 'true']]), '350');
  assert.equal(lockOf([['a', '450', 'x', 'true']]), '60');
  assert.equal(lockOf([['a', 'soon', 'x', 'true']]), '60', 'a bad estimate counts as the hard limit');
  const out = run(planFile(d, [['a', '100', 'x', 'true']]), {}, RUNNER, ['--plan']).out;
  assert.match(out, /^estimate: 100s of steps; the lock may take 380s more; no step starts past 570s$/m);
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

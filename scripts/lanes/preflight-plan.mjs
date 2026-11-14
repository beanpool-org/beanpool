#!/usr/bin/env node
// preflight-plan.mjs — the steps scripts/lanes/preflight.sh runs before a lane opens or pushes a PR.
//
// Why (Marty, 15 Nov 2026): most first-round NOT CLEAN results carried CI reds a lane could have caught in minutes, and each
// cost a whole Opus round (30-40 min). Counted in the queue board's decided.md from 1 to 15 Nov, PRs red on: table hashes
// (test-standby-health / test-replica-hashes) 11, native_dark_contrast 8, vitest source pins 6, no_node_names 5, typecheck 3,
// EnterpriseNotAProfile 2, ListPhoto.slots 2, no_google_fonts 2, signing-source rule 2. Not covered here: the web's browser
// dark-class check (1, a Playwright run) and flakes.
//
// The plan is:
//   1. `checks`: CI's "checks" shard, its list READ from .github/workflows/ci.yml (never a copy), through
//      TEST_ALL_ONLY scripts/test-all.sh. lint, typecheck, build, native_dark_contrast, no_node_names, no_google_fonts,
//      no_float_money, words... are all in it.
//   2. `words`: scripts/words/words.mjs lint and check (GUARDRAILS-build.md asks for both before every push).
//   3. The targeted steps the changed files call for, each run alone (never the full suite):
//      - a touched server route (router.get/post/...)            -> test-guest-view, test-health-cors
//      - a touched table (CREATE/ALTER/DROP TABLE, ADD COLUMN, the replica hash or copied-table files)
//                                                                -> test-standby-health, test-replica-hashes
//      - source changed in a vitest package (web, phone, manager, vault, core, engine, signin)
//                                                                -> in this order, while the time budget lasts:
//                                                                   1. the GUARD_TESTS that caught first-round reds
//                                                                      (always, whatever the budget: a handful of files)
//                                                                   2. the changed tests themselves
//                                                                   3. co-located tests and source pins: a test whose text
//                                                                      names a changed file by its REAL path (resolved from
//                                                                      the test's folder or the package root), never by
//                                                                      file name alone (app/(tabs)/_layout.tsx is not
//                                                                      app/_layout.tsx)
//                                                                   4. tests that import a changed file
//                                                                   5. the package's other tree-scanning tests (the scanners
//                                                                      with a record of reds are guards already)
//                                                                   3-5 hold at most MAX_EXTRA (60) files a package, closest
//                                                                   first. What does not fit is counted in the step's why
//                                                                   and left to CI, which runs every vitest file on every PR.
//        Every vitest step gets test-all.sh's TEST_ALL_TIMEOUT_MS (30 s), as CI does: core, engine, signin and the phone
//        read it, and at vitest's own 5 s a busy Mac times out suites CI passes (#1351 scrypt, #2441 statements).
//      - a script with a sibling .test.mjs test-all does not run -> that test
//
// The time budget (Opus review of #3180, 15 Nov: phone PRs planned 150-280 native files, 233-344 s of vitest alone, and the
// run could overrun the lane's 600 s Bash call). Each step carries an estimate in seconds, fitted to runs on the Mac at
// load 5-7 of 12 cores (VITEST_PACKAGES, EST). The plan's estimate stays under PREFLIGHT_PLAN_SECS (default 330, guards
// aside); preflight.sh gives the heavy-test lock what is left of PREFLIGHT_BUDGET_SECS (default 480, 8 minutes) and never
// starts a step its estimate says would end past PREFLIGHT_HARD_SECS (default 570, under the 600 s cap).
//
//   node scripts/lanes/preflight-plan.mjs [--base <ref>]   prints one step per line: <name> TAB <est s> TAB <why> TAB <command>
//   node scripts/lanes/preflight-plan.mjs --diff <file>    plans from a saved `git diff -U0` instead of git (tests)
//   node scripts/lanes/preflight-plan.mjs --replay <n>     the planner over the last n first-parent merges on the base, against
//                                                          today's tree: files and estimate per merge, then the distribution
//
// The functions are exported for scripts/lanes/preflight.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** CI's "checks" shard: the space-separated check names in ci.yml's matrix entry `name: checks`. Throws when it is missing. */
export function readChecksShard(ciYml) {
  const lines = ciYml.split('\n').filter(l => /^\s*-\s*\{\s*name:\s*checks\s*,/.test(l));
  if (lines.length !== 1) throw new Error(`ci.yml has ${lines.length} matrix entries named "checks"; preflight needs exactly one`);
  const m = lines[0].match(/\bchecks:\s*"([^"]*)"/);
  const names = m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
  if (names.length === 0) throw new Error('ci.yml\'s "checks" shard names no checks');
  for (const n of names) if (!/^[a-z0-9_]+$/.test(n)) throw new Error(`ci.yml's "checks" shard names "${n}", which is no check name`);
  return names.join(' ');
}

/** The vitest time-out test-all.sh (and so CI) gives every check: `export TEST_ALL_TIMEOUT_MS="${TEST_ALL_TIMEOUT_MS:-N}"`. */
export function readTestTimeout(testAllText) {
  const m = testAllText.match(/^export TEST_ALL_TIMEOUT_MS="\$\{TEST_ALL_TIMEOUT_MS:-(\d+)\}"$/m);
  if (!m) throw new Error('scripts/test-all.sh exports no TEST_ALL_TIMEOUT_MS default; preflight\'s vitest steps need the same one');
  return m[1];
}

/** A `git diff -U0` (or fuller) parsed into each file's touched lines, added and removed, without the +/- mark. */
export function parseDiff(diff) {
  const files = new Map();
  let cur = null;
  for (const line of diff.split('\n')) {
    let m;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) {
      cur = m[2];
      if (!files.has(cur)) files.set(cur, []);
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      const p = line.slice(4).replace(/^[ab]\//, '');
      if (line.startsWith('+++ ') && p !== '/dev/null') { cur = p; if (!files.has(cur)) files.set(cur, []); }
      continue;
    }
    if (!cur) continue;
    if ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      files.get(cur).push(line.slice(1));
    }
  }
  return files;
}

// ── the rules ──
const SERVER_SRC = /^apps\/server\/src\/(?!test-|__fixtures__\/|.*\/__tests__\/).+\.(ts|sql)$/;
export const ROUTE_LINE = /\b[A-Za-z_$][\w$]*\s*\.\s*(get|post|put|patch|delete|del|all)\s*\(\s*['"`]\//;
export const ROUTER_LINE = /\b[A-Za-z_$]*[Rr]outer\s*\.\s*(get|post|put|patch|delete|del|all|use)\s*\(/;
export const TABLE_LINE = /\b(CREATE|DROP|ALTER)\s+(TEMP\s+|TEMPORARY\s+|VIRTUAL\s+)?TABLE\b|\bADD\s+COLUMN\b|\bDROP\s+COLUMN\b|\bRENAME\s+(COLUMN|TO)\b|\bTABLE_HASHES_VERSION\b/i;
/** Files whose any change reaches the whole-copy table list or the replica hashes. */
export const TABLE_FILES = new Set([
  'apps/server/src/db/schema.sql',
  'apps/server/src/db/table-rules.ts',
  'apps/server/src/engine/replica-hashes.ts',
  'apps/server/src/engine/copied-tables.ts',
]);

/**
 * The vitest packages: directory, pnpm name, and the time model the budget uses: seconds to start, plus seconds per test
 * file (two workers). Fitted to runs on the Mac at load 5-7 of 12 cores (15 Nov): phone 279 files 233 s, 208 files 205 s,
 * 54 tree scanners 66 s; web 77 files 52 s, 32 files 24 s; manager 74 files 37 s; vault 16 files 38 s; core 55 files 12 s.
 * Checked at load 12-13 on #3123's capped plan: web 53 files 48 s (est 53), phone 75 files 78 s (85), manager 16 files 21 s
 * (est 13, so its start went up), vault 15 files 43 s (41), core 43 files 14 s (16); 204 s in all against 208 estimated.
 */
export const VITEST_PACKAGES = [
  { dir: 'apps/pwa', name: '@beanpool/pwa', start: 8, perFile: 0.7 },
  { dir: 'apps/native', name: 'beanpool-pillar', start: 10, perFile: 1.0 },
  { dir: 'apps/manager', name: '@beanpool/manager', start: 13, perFile: 0.5 },
  { dir: 'apps/vault', name: '@beanpool/vault', start: 5, perFile: 2.4 },
  { dir: 'packages/beanpool-core', name: '@beanpool/core', start: 5, perFile: 0.25 },
  { dir: 'packages/beanpool-engine', name: '@beanpool/engine', start: 5, perFile: 0.5 },
  { dir: 'packages/beanpool-signin', name: '@beanpool/signin', start: 5, perFile: 0.5 },
];
/**
 * Tests that caught first-round CI reds (the queue board's decided.md, Oct-Nov 2026). They run whenever their package has a
 * touched source file, ahead of everything else and whatever the budget: a handful of files, and the reds lanes most often
 * missed. The other classes in that count are steps of their own (tables, routes), checks in the "checks" shard
 * (native_dark_contrast, no_node_names, typecheck, no_google_fonts...) or source pins (rule 3 in the header).
 */
export const GUARD_TESTS = [
  'apps/pwa/src/pages/EnterpriseNotAProfile.test.tsx', //    a new profile door: #3029 #3074
  'apps/pwa/src/components/ListPhoto.slots.test.ts', //      #2897 #3074
  'apps/pwa/src/lib/signing-source-rule.test.ts', //         #2770 #3090
  'apps/pwa/src/darkModeHover.test.ts', //                   #2484 #3148
  'apps/native/utils/__tests__/dark-mode-sources.test.ts', // #1844 #2536 #2994 #3035
];
/** The plan's estimate stays under this many seconds (guards aside): vitest files past it are left to CI. */
export const PLAN_SECS = Number(process.env.PREFLIGHT_PLAN_SECS || 330);
/** Past the guards and the changed tests, at most this many pins, scanners and importers in one package (closest first). */
export const MAX_EXTRA = Number(process.env.PREFLIGHT_MAX_EXTRA || 60);
/** Estimates of the fixed steps, seconds (the Mac, 15 Nov: checks 68-118 s, words 6 s, guest-view 41 s, health-cors 3 s,
 *  standby-health 29 s, replica-hashes under 1 s, each plus the suite runner's start). */
export const EST = { checks: 120, words: 8, 'test-guest-view': 45, 'test-health-cors': 8, 'test-standby-health': 32,
  'test-replica-hashes': 5, scriptTests: 10 };

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|js|jsx|mjs)$/;
const SCANNER = /\breaddirSync\b|\bglobSync\b|\breaddir\s*\(|\bfs\.glob\b/;
const CLASSES = ['changed', 'pins', 'importers', 'scanners'];

const shq = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const stripExt = f => f.replace(SOURCE_EXT, '');
// A path that starts a quoted string: a read ('../../app/_layout.tsx'), an import or mock ('../db'), a test's title. A path
// in prose ("the root layout (app/_layout.tsx)") is a comment, not a pin: 68 phone tests mention utils/db.ts that way.
const QUOTED_PATH = /['"`]((?:\.{1,2}\/|@\/|~\/)?[\w$()[\].-]+(?:\/[\w$()[\].-]+)+)/g;
const BARE = /['"`]([\w$()[\].-]+\.(?:tsx?|jsx?|mjs|cjs))['"`]/g;

/**
 * The files a test names by path, resolved to repo paths without the extension: `withExt` those named with their extension
 * (a source pin reads the file's text), `noExt` those named without (an import). A quoted path is tried from the test's
 * folder, the package root (and its src/ for an @/ or ~/ alias) and the repo root. A bare quoted file name ('X.tsx', as in
 * resolve(__dirname, 'X.tsx')) is tried from the test's folder and the package root, and counts anywhere in the package
 * only when one source file there has that name (`uniqueNames`: name -> path).
 */
export function namedPaths(text, testFile, pkgDir, uniqueNames = new Map()) {
  const td = path.posix.dirname(testFile);
  const withExt = new Set(), noExt = new Set();
  const add = (p, ext) => (ext ? withExt : noExt).add(stripExt(path.posix.normalize(p)));
  for (const [, c] of text.matchAll(QUOTED_PATH)) {
    const ext = SOURCE_EXT.test(c);
    if (c.startsWith('./') || c.startsWith('../')) add(path.posix.join(td, c), ext);
    else if (c.startsWith('@/') || c.startsWith('~/')) {
      add(path.posix.join(pkgDir, c.slice(2)), ext);
      add(path.posix.join(pkgDir, 'src', c.slice(2)), ext);
    } else { add(path.posix.join(pkgDir, c), ext); add(path.posix.join(td, c), ext); add(c, ext); }
  }
  for (const [, name] of text.matchAll(BARE)) {
    add(path.posix.join(td, name), true);
    add(path.posix.join(pkgDir, name), true);
    if (uniqueNames.has(name)) add(uniqueNames.get(name), true);
  }
  return { withExt, noExt };
}

function serverSuite(name, why) {
  return { name: `server:${name}`, est: EST[name], why,
    cmd: `SERVER_SUITES_ONLY=${name} TEST_ALL_JOBS=1 node scripts/run-server-suites.mjs` };
}

/** One vitest package's tests, by class (see the header). */
function classify(pkg, mine, repo) {
  const changedTests = mine.filter(f => TEST_FILE.test(f) && repo.exists(f));
  const sources = mine.filter(f => !TEST_FILE.test(f));
  const guards = sources.length ? GUARD_TESTS.filter(t => t.startsWith(pkg.dir + '/') && repo.exists(t)) : [];
  const cls = { changed: changedTests.filter(t => !guards.includes(t)), pins: [], scanners: [], importers: [] };
  if (sources.length) {
    const keys = new Set();
    for (const f of sources) {
      keys.add(stripExt(f));
      if (/\/index$/.test(stripExt(f))) keys.add(path.posix.dirname(f));
    }
    const byName = new Map();
    for (const f of repo.files(pkg.dir)) {
      if (!SOURCE_EXT.test(f) || TEST_FILE.test(f)) continue;
      const b = path.posix.basename(f);
      byName.set(b, byName.has(b) ? null : f);
    }
    const uniqueNames = new Map([...byName].filter(([, f]) => f));
    const hits = set => [...keys].filter(k => set.has(k)).length;
    const score = new Map();
    for (const t of repo.tests(pkg.dir)) {
      if (guards.includes(t) || changedTests.includes(t)) continue;
      const text = repo.read(t);
      const base = path.posix.join(path.posix.dirname(t), path.posix.basename(t).replace(/(\.[\w-]+)*\.test\.\w+$/, ''));
      const named = namedPaths(text, t, pkg.dir, uniqueNames);
      const pins = hits(named.withExt), imports = hits(named.noExt);
      // Closest first when the cap bites: co-located, then the tests that name the most touched files.
      score.set(t, (keys.has(base) ? 1000 : 0) + pins + imports);
      if (keys.has(base) || pins) cls.pins.push(t);
      else if (imports) cls.importers.push(t);
      else if (SCANNER.test(text)) cls.scanners.push(t);
    }
    for (const c of CLASSES) cls[c].sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0) || (a < b ? -1 : 1));
  }
  return { pkg, sources, changedTests, guards, cls };
}

/**
 * The steps for these touched files. `repo` gives the tree: `tests(dir)` lists a package's test files (repo-relative),
 * `files(dir)` all its tracked files, `read(file)` returns a file's text ('' when missing), `exists(file)`, and
 * `testAllText` / `ciYml` are those files' text. Each step is { name, est (seconds), why, cmd }.
 */
export function planSteps(touched, repo, { planSecs = PLAN_SECS, maxExtra = MAX_EXTRA } = {}) {
  const steps = [];
  const files = [...touched.keys()];
  const checks = readChecksShard(repo.ciYml);
  const timeout = readTestTimeout(repo.testAllText);
  steps.push({ name: 'checks', est: EST.checks, why: 'CI\'s "checks" shard, read from .github/workflows/ci.yml',
    cmd: `TEST_ALL_ONLY=${shq(checks)} bash scripts/test-all.sh` });
  steps.push({ name: 'words', est: EST.words, why: 'words lint + check (GUARDRAILS-build.md)',
    cmd: 'node scripts/words/words.mjs lint && node scripts/words/words.mjs check' });

  // A touched server route: the two sweeps that list every route the node serves.
  const routeFiles = files.filter(f => SERVER_SRC.test(f) && touched.get(f).some(l => ROUTE_LINE.test(l) || ROUTER_LINE.test(l)));
  if (routeFiles.length) {
    const why = `server route touched in ${routeFiles.slice(0, 3).join(', ')}${routeFiles.length > 3 ? ' …' : ''}`;
    steps.push(serverSuite('test-guest-view', why), serverSuite('test-health-cors', why));
  }

  // A touched table: the whole-copy table list and the replica hashes.
  const tableFiles = files.filter(f => TABLE_FILES.has(f) || (SERVER_SRC.test(f) && touched.get(f).some(l => TABLE_LINE.test(l))));
  if (tableFiles.length) {
    const why = `table touched in ${tableFiles.slice(0, 3).join(', ')}${tableFiles.length > 3 ? ' …' : ''}`;
    steps.push(serverSuite('test-standby-health', why), serverSuite('test-replica-hashes', why));
  }

  // A script with a sibling test test-all.sh does not name (those it names run in a check), or a touched script test.
  const scriptTests = new Set();
  for (const f of files) {
    if (!/^scripts\/.+\.m?js$/.test(f)) continue;
    const t = /\.test\.m?js$/.test(f) ? f : f.replace(/\.(m?js)$/, '.test.$1');
    if (repo.exists(t) && !repo.testAllText.includes(t)) scriptTests.add(t);
  }
  const scriptStep = scriptTests.size ? { name: 'script-tests', est: EST.scriptTests,
    why: `script tests test-all.sh does not run: ${[...scriptTests].sort().join(', ')}`,
    cmd: `node --test ${[...scriptTests].sort().map(shq).join(' ')}` } : null;

  // Each vitest package with a touched source file: guards first (whatever the budget), then the other classes in order,
  // across packages, while the plan's estimate stays under planSecs. What is left over is counted and left to CI.
  const fixed = steps.reduce((n, s) => n + s.est, 0) + (scriptStep ? scriptStep.est : 0);
  const stepEst = (pkg, n) => (n ? Math.ceil(pkg.start + pkg.perFile * n) : 0);
  const plans = [];
  for (const pkg of VITEST_PACKAGES) {
    const mine = files.filter(f => f.startsWith(pkg.dir + '/') && SOURCE_EXT.test(f) && !/\/(node_modules|dist)\//.test(f));
    if (!mine.length) continue;
    const p = classify(pkg, mine, repo);
    p.chosen = [...p.guards];
    p.left = { changed: 0, pins: 0, scanners: 0, importers: 0 };
    p.extra = 0;
    plans.push(p);
  }
  let est = fixed + plans.reduce((n, p) => n + stepEst(p.pkg, p.chosen.length), 0);
  for (const c of CLASSES) {
    for (const p of plans) {
      for (const t of p.cls[c]) {
        // The plan's estimate is the sum of the steps' whole seconds, so the check adds this step's rounded growth.
        const grow = stepEst(p.pkg, p.chosen.length + 1) - stepEst(p.pkg, p.chosen.length);
        const capped = c !== 'changed' && p.extra >= maxExtra;
        if (!capped && est + grow <= planSecs) {
          p.chosen.push(t);
          est += grow;
          if (c !== 'changed') p.extra++;
        } else p.left[c]++;
      }
    }
  }
  for (const p of plans) {
    const { pkg, cls, left } = p;
    if (!p.chosen.length) continue;
    const ran = c => cls[c].length - left[c];
    const leftText = CLASSES.filter(c => left[c]).map(c => `${left[c]} ${c}`).join(', ');
    const why = `${p.sources.length} source + ${p.changedTests.length} test file(s) touched in ${pkg.dir}: ${p.guards.length} guards, `
      + `${ran('changed')} changed tests, ${ran('pins')} pins/co-located, ${ran('importers')} importers, ${ran('scanners')} tree scanners`
      + (leftText ? `; left to CI (past ${maxExtra} a package or the ${planSecs} s plan budget): ${leftText}` : '');
    const rel = p.chosen.map(t => path.posix.relative(pkg.dir, t)).sort();
    steps.push({ name: `vitest:${pkg.name}`, est: stepEst(pkg, rel.length), why,
      files: rel.length, left: CLASSES.reduce((k, c) => k + left[c], 0),
      cmd: `TEST_ALL_TIMEOUT_MS=${timeout} pnpm --filter ${pkg.name} exec vitest run --maxWorkers=2 --passWithNoTests ${rel.map(shq).join(' ')}` });
  }

  // Not a guide step: `pnpm --filter @beanpool/guide test` took 301 s on the Mac (15 Nov), over half a lane's 600 s Bash
  // call, for 3 guide reds in two weeks. CI's vitest-rest shard runs it.
  if (scriptStep) steps.push(scriptStep);
  return steps;
}

/** The real tree, read from git and disk. */
export function gitRepo(root = REPO_ROOT) {
  const cache = new Map();
  let tracked = null;
  const listTracked = () => tracked ??= execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
  return {
    ciYml: fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
    testAllText: fs.readFileSync(path.join(root, 'scripts/test-all.sh'), 'utf8'),
    tests: dir => listTracked().filter(f => f.startsWith(dir + '/') && TEST_FILE.test(f)
      && !/\/(node_modules|dist)\//.test(f) && fs.existsSync(path.join(root, f))),
    files: dir => listTracked().filter(f => f.startsWith(dir + '/') && !/\/(node_modules|dist)\//.test(f)),
    read: f => {
      if (!cache.has(f)) { try { cache.set(f, fs.readFileSync(path.join(root, f), 'utf8')); } catch { cache.set(f, ''); } }
      return cache.get(f);
    },
    exists: f => fs.existsSync(path.join(root, f)),
  };
}

/** What this branch touches against the base: committed, staged and unstaged changes, and new untracked files. */
export function touchedFromGit(base = 'origin/main', root = REPO_ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });
  const mb = git('merge-base', base, 'HEAD').trim();
  const touched = parseDiff(git('diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', mb));
  for (const f of git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean)) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* unreadable: still a touched file */ }
    touched.set(f, text.split('\n'));
  }
  return touched;
}

/** The planner over the last n first-parent commits on the base, each diffed against its first parent, on today's tree. */
export function replay(n, base = 'origin/main', root = REPO_ROOT) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 });
  const repo = gitRepo(root);
  const rows = [];
  for (const line of git('log', '--first-parent', '-n', String(n), '--format=%H %s', base).split('\n').filter(Boolean)) {
    const sha = line.slice(0, 40);
    const pr = (line.match(/\(#(\d+)\)\s*$/) || [])[1] || '';
    const steps = planSteps(parseDiff(git('diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', `${sha}^1`, sha)), repo);
    const vitest = steps.filter(s => s.name.startsWith('vitest:'));
    rows.push({ sha: sha.slice(0, 8), pr, steps: steps.length, files: vitest.reduce((k, s) => k + s.files, 0),
      left: vitest.reduce((k, s) => k + s.left, 0), est: steps.reduce((k, s) => k + s.est, 0) });
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  try {
    if (opt('--replay')) {
      const rows = replay(Number(opt('--replay')), opt('--base') || 'origin/main');
      process.stdout.write('merge     PR     steps  vitest-files  left-to-CI  est-s\n');
      for (const r of rows) process.stdout.write(`${r.sha}  ${r.pr.padEnd(5)}  ${String(r.steps).padStart(5)}  ${String(r.files).padStart(12)}  ${String(r.left).padStart(10)}  ${String(r.est).padStart(5)}\n`);
      const q = (xs, f) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
      const est = rows.map(r => r.est).sort((a, b) => a - b), fl = rows.map(r => r.files).sort((a, b) => a - b);
      process.stdout.write(`${rows.length} merges. est s: p50 ${q(est, 0.5)}, p90 ${q(est, 0.9)}, max ${est.at(-1)}. vitest files: `
        + `p50 ${q(fl, 0.5)}, p90 ${q(fl, 0.9)}, max ${fl.at(-1)}. Plans that left files to CI: ${rows.filter(r => r.left).length}.\n`);
    } else {
      const touched = opt('--diff') ? parseDiff(fs.readFileSync(opt('--diff'), 'utf8')) : touchedFromGit(opt('--base') || 'origin/main');
      for (const s of planSteps(touched, gitRepo())) {
        process.stdout.write(`${s.name}\t${s.est}\t${s.why.replace(/[\t\n]/g, ' ')}\t${s.cmd}\n`);
      }
    }
  } catch (e) {
    console.error(`preflight-plan: ${e.message}`);
    process.exit(2);
  }
}

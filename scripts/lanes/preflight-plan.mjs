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
//   node scripts/lanes/preflight-plan.mjs --draft <part>   a draft PR's fast CI check, one part: types, guards or tests (planDraft)
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
  // The phone's colour ceiling, the other tree scanner preflight.test.mjs holds a phone style change to. As a plain scanner
  // it ran only while it sorted inside MAX_EXTRA by name: main had it 60th of 60 (21 Nov 2026) and #3310's sync, one more
  // scanner test ahead of it, put it 61st (CI red on the merge ref).
  'apps/native/utils/__tests__/static-colours-ceiling.test.ts',
];
/** The plan's estimate stays under this many seconds (guards aside): vitest files past it are left to CI. */
export const PLAN_SECS = Number(process.env.PREFLIGHT_PLAN_SECS || 330);
/** Past the guards and the changed tests, at most this many pins, scanners and importers in one package (closest first). */
export const MAX_EXTRA = Number(process.env.PREFLIGHT_MAX_EXTRA || 60);
/** Estimates of the fixed steps, seconds (the Mac, 15 Nov: checks 68-118 s, words 6 s, guest-view 41 s, health-cors 3 s,
 *  standby-health 29 s, replica-hashes under 1 s, each plus the suite runner's start). The script tests are a start plus
 *  each file: 17 Nov at load 6.5, the seven test-all.sh does not run took 21 s side by side (words/draft.test.mjs 26 s
 *  alone, glossary 10 s, the rest 0-2 s), so seven plan 33 s. */
export const EST = { checks: 120, words: 8, 'test-guest-view': 45, 'test-health-cors': 8, 'test-standby-health': 32,
  'test-replica-hashes': 5, scriptTestsStart: 5, scriptTestsPerFile: 4 };

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
 * `files(dir)` all its tracked files, `read(file)` returns a file's text ('' when missing), `exists(file)`, `serverRuns()`
 * the server-suite manifest's runs (manifestRuns; only the draft's tests part reads it), and `testAllText` / `ciYml` are
 * those files' text. Each step is { name, est (seconds), why, cmd }. `leftTo` is where a vitest
 * step's why says the files past the budget go (the draft check's are left to the full run).
 */
export function planSteps(touched, repo, { planSecs = PLAN_SECS, maxExtra = MAX_EXTRA,
  leftTo = `CI (past ${maxExtra} a package or the ${planSecs} s plan budget)` } = {}) {
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
  const scriptStep = scriptTests.size ? { name: 'script-tests', est: EST.scriptTestsStart + EST.scriptTestsPerFile * scriptTests.size,
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
      + (leftText ? `; left to ${leftTo}: ${leftText}` : '');
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

// ── the draft check: a DRAFT pull request's fast CI check (ci.yml jobs.draft; Marty, 17 Nov 2026) ──
// A draft's run is three jobs side by side instead of the 19-job full run, each planned here from the PR's diff:
//   types   turbo build + lint + typecheck of the packages the diff reaches and their dependents (every package when a root
//           config changed), and a syntax check of changed scripts
//   guards  CI's "checks" shard minus build, lint and typecheck (the types part runs those narrowed), and words lint + check
//   tests   the targeted steps above (route and table suites, the vitest files picked within the budget, changed scripts'
//           tests), plus the server suites the diff itself changes, shortest first, while the part stays inside its budget
// The full run (ready_for_review, then every push) and the merge queue's run decide; this only fails a draft sooner.
//
// TIME (Opus review of #3280, 17 Nov: the changed suites had no budget, so #3054's diff planned 4850 s, preflight stopped
// past ci.yml's PREFLIGHT_HARD_SECS=1200 and exited 75, and the draft was red on every push with nothing to fix). A draft
// check is never red for time alone: every step whose time grows with the diff has a budget or a bound, and no part plans
// past DRAFT_PART_SECS, a quarter of the job's 1200 s.
//   types   scripts-syntax: each changed script, ~0.03 s a node --check (17 Nov); the tree's 145 scripts plan 8 s. It runs
//           first. turbo: one step, 180 s for the packages reached, 240 s for every package (CI's checks shard, 16 Nov:
//           build 2m22s, lint 3m29s, typecheck 2m24s side by side); never more than every package. It runs last.
//   guards  fixed: the shard's guards and words, whatever the diff.
//   tests   the route and table suites: four at most, fixed. script-tests: a start plus each file, of the seven the tree
//           has. vitest: within DRAFT_PLAN_SECS (planSteps). server:changed: within what the others leave of it (below).
// Replayed over main's last 600 merges (17 Nov), before this: the tests part planned past 300 s on 32, past 1200 s on 3.
export const DRAFT_PARTS = ['types', 'guards', 'tests'];
/** Root files whose change reaches every package's build, lint or typecheck: the types part then runs every package. */
export const ROOT_WIDE = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'turbo.json',
  'eslint.config.mjs', '.npmrc']);
/** The "checks" shard's checks the types part runs narrowed to the diff, and the guards part so leaves out. */
export const DRAFT_TURBO_CHECKS = ['build', 'lint', 'typecheck'];
/** The tests part's budget (seconds of estimate): its job is about a minute of setup and this, inside the 5-minute aim. */
export const DRAFT_PLAN_SECS = Number(process.env.PREFLIGHT_DRAFT_PLAN_SECS || 200);
/** No draft part plans past this (seconds of estimate), whatever the diff: ci.yml's PREFLIGHT_HARD_SECS (1200) then stops
 *  a step only when a part runs at four times its estimate. preflight.test.mjs holds every part to it. */
export const DRAFT_PART_SECS = 300;
/** The changed server suites run this many at a time (the step's TEST_ALL_JOBS, and its estimate). */
export const DRAFT_SERVER_JOBS = 2;
/** A run the durations snapshot lacks (most often a suite the PR adds): past the known runs' p90 (28 s), p50 6.5 s. */
export const UNKNOWN_RUN_SECS = 60;
/** run-server-suites.mjs's own start, before its first suite. */
const SERVER_START_SECS = 10;
const WORKSPACE_DIR = /^(apps|packages|workers)\/[^/]+\//;
const SERVER_SUITE_FILE = /^apps\/server\/src\/(test-[\w-]+)\.ts$/;

// The server-suite manifest's runs (scripts/server-suites.mjs: each suite, its variants, which run serially). Loaded here
// and not imported, so a manifest that does not load fails only a draft plan that needs it (suite_registration, in the
// guards part, says why), never the lane's preflight or the other parts.
let MANIFEST = null, MANIFEST_ERROR = null;
try { MANIFEST = await import('../server-suites.mjs'); } catch (e) { MANIFEST_ERROR = e; }
/** The manifest's runs, each { id, name, serial }: a suite's id is its name, a variant's `name(tag)`. */
export function manifestRuns(m = MANIFEST) {
  if (!m) throw new Error(`scripts/server-suites.mjs does not load: ${MANIFEST_ERROR && MANIFEST_ERROR.message}`);
  return [
    ...m.SUITES.map(e => (typeof e === 'string' ? e : e.name)).map(name => ({ id: name, name })),
    ...m.VARIANTS.map(v => ({ id: v.tag ? `${v.name}(${v.tag})` : v.name, name: v.name })),
  ].map(r => ({ ...r, serial: Object.hasOwn(m.SERIAL, r.id) }));
}

/**
 * Seconds these runs take as run-server-suites.mjs runs them, DRAFT_SERVER_JOBS at a time: its start, then the pooled runs
 * longest first (one the snapshot lacks first of all), each to the worker free soonest, then the serial runs one at a time,
 * alone. `durations` is the committed snapshot (run id -> seconds; medians of CI's passing runs, which on a CI shard of 16
 * Nov added up to within 10% of the shard's suite time).
 */
export function serverRunsEst(runs, durations, jobs = DRAFT_SERVER_JOBS) {
  const known = r => typeof durations[r.id] === 'number';
  const secs = r => (known(r) ? durations[r.id] : UNKNOWN_RUN_SECS);
  const weight = r => (known(r) ? durations[r.id] : Infinity);
  const pooled = runs.filter(r => !r.serial).sort((a, b) => weight(b) - weight(a));
  const workers = Array(jobs).fill(0);
  for (const r of pooled) workers[workers.indexOf(Math.min(...workers))] += secs(r);
  const serial = runs.filter(r => r.serial).reduce((k, r) => k + secs(r), 0);
  return Math.ceil(SERVER_START_SECS + Math.max(...workers) + serial);
}

/** The draft check's steps for one part, against `mergeBase` (the commit the PR's diff starts from). */
export function planDraft(part, touched, repo, { mergeBase, planSecs = DRAFT_PLAN_SECS, maxExtra = MAX_EXTRA } = {}) {
  if (!DRAFT_PARTS.includes(part)) throw new Error(`--draft takes ${DRAFT_PARTS.join(', ')}, not "${part}"`);
  const files = [...touched.keys()];
  const steps = [];
  if (part === 'types') {
    if (!/^[0-9a-f]{7,40}$/.test(mergeBase || '')) throw new Error('the types part needs the merge base commit');
    const wide = files.filter(f => ROOT_WIDE.has(f));
    const pkgs = [...new Set(files.filter(f => WORKSPACE_DIR.test(f) && repo.exists(f.match(WORKSPACE_DIR)[0] + 'package.json'))
      .map(f => f.match(WORKSPACE_DIR)[0].slice(0, -1)))].sort();
    const scripts = files.filter(f => !WORKSPACE_DIR.test(f) && !/(^|\/)node_modules\//.test(f) && repo.exists(f)).sort();
    const js = scripts.filter(f => /\.(m?js|cjs)$/.test(f));
    // A shell script parses in the shell its #! names; zsh only where the runner has it. One with no #! is a library sourced by
    // its caller (scripts/lanes/lib.sh is zsh): not checked here, its callers' suites read it.
    const sh = scripts.filter(f => /\.sh$/.test(f)).map(f => [f, (/^#!.*\b(bash|zsh|sh)\b/.exec(repo.read(f).split('\n')[0]) || [])[1]])
      .filter(([, shell]) => shell);
    const shCmd = ([f, shell]) => (shell === 'zsh' ? `{ ! command -v zsh >/dev/null || zsh -n ${shq(f)}; }` : `bash -n ${shq(f)}`);
    // The quick step first: turbo, the long one, goes last, so no step waits behind it for the clock.
    if (js.length || sh.length) steps.push({ name: 'scripts-syntax', est: Math.ceil(2 + 0.05 * js.length + 0.01 * sh.length),
      why: `${js.length + sh.length} changed script(s) parse`,
      cmd: [...js.map(f => `node --check ${shq(f)}`), ...sh.map(shCmd)].join(' && ') });
    if (wide.length) steps.push({ name: 'turbo', est: 240, why: `every package: ${wide.join(', ')} changed`,
      cmd: 'pnpm turbo run build lint typecheck --continue' });
    else if (pkgs.length) steps.push({ name: 'turbo', est: 180,
      why: `${pkgs.join(', ')} and every package that depends on ${pkgs.length > 1 ? 'them' : 'it'}`,
      cmd: `pnpm turbo run build lint typecheck --continue --filter=${shq(`...[${mergeBase}]`)}` });
  } else if (part === 'guards') {
    const checks = readChecksShard(repo.ciYml).split(' ').filter(c => !DRAFT_TURBO_CHECKS.includes(c));
    steps.push({ name: 'guards', est: 120, why: 'CI\'s "checks" shard but build, lint and typecheck (the types part runs those)',
      cmd: `TEST_ALL_ONLY=${shq(checks.join(' '))} bash scripts/test-all.sh` });
    steps.push({ name: 'words', est: EST.words, why: 'words lint + check',
      cmd: 'node scripts/words/words.mjs lint && node scripts/words/words.mjs check' });
  } else {
    // The targeted steps of a preflight, its two whole-tree steps left to the guards part (so out of the budget too), all
    // inside planSecs: the route and table suites and the script tests (bounded, always), the vitest guards and changed tests,
    // then the server suites the diff changes, then the vitest pins, importers and scanners with what is left.
    const fixed = EST.checks + EST.words;
    const leftTo = `the full run (past ${maxExtra} a package or the draft's ${planSecs} s budget)`;
    const targetedWithin = (secs, extra) => planSteps(touched, repo, { planSecs: secs + fixed, maxExtra: extra, leftTo })
      .filter(s => s.name !== 'checks' && s.name !== 'words');
    const total = ss => ss.reduce((k, s) => k + s.est, 0);
    // A server suite the diff changes runs itself, every run of it (its variants too), unless a route or table step has it.
    // Registered suites only: an unregistered one is suite_registration's red, in the guards part.
    const names = [...new Set(files.map(f => (SERVER_SUITE_FILE.exec(f) || [])[1]).filter(Boolean))]
      .filter(n => repo.exists(`apps/server/src/${n}.ts`));
    const picked = [], left = [];
    let serverEst = 0;
    if (names.length) {
      const runs = repo.serverRuns();
      let durations = {};
      try { durations = JSON.parse(repo.read('scripts/server-suite-durations.json') || '{}'); } catch { /* none: each run unknown */ }
      // What the suites must fit beside: the plan without the vitest pins, importers and scanners (maxExtra 0). planSteps
      // takes every package's changed tests before any of those, so the full plan below, with the suites' time taken off its
      // budget, still takes the same changed tests.
      const first = targetedWithin(planSecs, 0);
      const have = new Set(first.filter(s => s.name.startsWith('server:')).map(s => s.name.slice(7)));
      const suites = names.filter(n => !have.has(n)).map(n => ({ name: n, runs: runs.filter(r => r.name === n) }))
        .filter(s => s.runs.length).map(s => ({ ...s, alone: serverRunsEst(s.runs, durations) }))
        .sort((a, b) => a.alone - b.alone || (a.name < b.name ? -1 : 1));
      const est = ss => serverRunsEst(ss.flatMap(s => s.runs), durations);
      // Shortest first while they fit: from the first that does not, the rest are left.
      for (const s of suites) (left.length || total(first) + est([...picked, s]) > planSecs ? left : picked).push(s);
      if (picked.length) serverEst = est(picked);
    }
    steps.push(...targetedWithin(planSecs - serverEst, maxExtra));
    if (picked.length || left.length) {
      const list = ss => ss.map(s => s.name).sort().join(', ');
      const why = (picked.length ? `the server suites this diff changes, ${DRAFT_SERVER_JOBS} at a time: ${list(picked)}` : 'no server suite this diff changes fits')
        + (left.length ? `; left to the full run (past the draft's ${planSecs} s budget), ${left.length}: ${list(left)}` : '');
      steps.push({ name: 'server:changed', est: serverEst, why, cmd: picked.length
        ? `SERVER_SUITES_ONLY=${shq(picked.map(s => s.name).sort().join(' '))} TEST_ALL_JOBS=${DRAFT_SERVER_JOBS} node scripts/run-server-suites.mjs`
        : 'true' });
    }
    if (!steps.length) steps.push({ name: 'none', est: 0, why: 'no test this diff calls for (the full run runs them all)', cmd: 'true' });
  }
  if (!steps.length) steps.push({ name: 'none', est: 0, why: 'nothing in this part for this diff', cmd: 'true' });
  return steps;
}

/** The commit the branch's diff against `base` starts from. */
export function mergeBaseOf(base = 'origin/main', root = REPO_ROOT) {
  return execFileSync('git', ['merge-base', base, 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
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
    serverRuns: () => manifestRuns(),
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
      const base = opt('--base') || 'origin/main';
      const touched = opt('--diff') ? parseDiff(fs.readFileSync(opt('--diff'), 'utf8')) : touchedFromGit(base);
      const part = opt('--draft');
      const steps = part === undefined ? planSteps(touched, gitRepo())
        : planDraft(part, touched, gitRepo(), { mergeBase: opt('--merge-base') || mergeBaseOf(base) });
      for (const s of steps) {
        process.stdout.write(`${s.name}\t${s.est}\t${s.why.replace(/[\t\n]/g, ' ')}\t${s.cmd}\n`);
      }
    }
  } catch (e) {
    console.error(`preflight-plan: ${e.message}`);
    process.exit(2);
  }
}

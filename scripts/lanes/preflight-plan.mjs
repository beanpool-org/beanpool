#!/usr/bin/env node
// preflight-plan.mjs — the steps scripts/lanes/preflight.sh runs before a lane opens or pushes a PR.
//
// Why (Marty, 15 Nov 2026): most first-round NOT CLEAN results carried CI reds a lane could have caught in minutes, and each
// cost a whole Opus round (30-40 min). Counted in the queue board's decided.md from 1 to 15 Nov, PRs red on: table hashes
// (test-standby-health / test-replica-hashes) 11, native_dark_contrast 8, vitest source pins 6, no_node_names 5, typecheck 3,
// EnterpriseNotAProfile 2, ListPhoto.slots 2, no_google_fonts 2, signing-source rule 2, pwa dark classes 2.
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
//                                                                -> that package's tree-scanning tests (EnterpriseNotAProfile,
//                                                                   darkModeHover, ListPhoto.slots, static-colours-ceiling,
//                                                                   signing-source-rule...), the tests that name a changed file
//                                                                   (source pins, importers) and the changed tests themselves
//      - a guide page                                            -> the guide package's tests
//      - a script with a sibling .test.mjs test-all does not run -> that test
//
//   node scripts/lanes/preflight-plan.mjs [--base <ref>]     prints one step per line: <name> TAB <why> TAB <command>
//   node scripts/lanes/preflight-plan.mjs --diff <file>      plans from a saved `git diff -U0` instead of git (tests)
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

/** The vitest packages: directory, pnpm name, extra environment for its run. */
export const VITEST_PACKAGES = [
  { dir: 'apps/pwa', name: '@beanpool/pwa' },
  { dir: 'apps/native', name: 'beanpool-pillar', env: 'TEST_ALL_TIMEOUT_MS=30000' },
  { dir: 'apps/manager', name: '@beanpool/manager' },
  { dir: 'apps/vault', name: '@beanpool/vault' },
  { dir: 'packages/beanpool-core', name: '@beanpool/core' },
  { dir: 'packages/beanpool-engine', name: '@beanpool/engine' },
  { dir: 'packages/beanpool-signin', name: '@beanpool/signin' },
];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.test\.(ts|tsx|js|jsx|mjs)$/;
const SCANNER = /\breaddirSync\b|\bglobSync\b|\breaddir\s*\(|\bfs\.glob\b/;
/** Past this many tests in one package, only the scanners, the changed tests and exact file-name pins are kept. */
export const MAX_TESTS_PER_PACKAGE = Number(process.env.PREFLIGHT_MAX_TESTS || 80);

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shq = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function serverSuite(name, why) {
  return { name: `server:${name}`, why, cmd: `SERVER_SUITES_ONLY=${name} TEST_ALL_JOBS=1 node scripts/run-server-suites.mjs` };
}

/**
 * The steps for these touched files. `repo` gives the tree: `tests(dir)` lists a package's test files (repo-relative),
 * `read(file)` returns a file's text ('' when missing), `exists(file)`, and `testAllText` / `ciYml` are those files' text.
 */
export function planSteps(touched, repo) {
  const steps = [];
  const files = [...touched.keys()];
  const checks = readChecksShard(repo.ciYml);
  steps.push({ name: 'checks', why: 'CI\'s "checks" shard, read from .github/workflows/ci.yml',
    cmd: `TEST_ALL_ONLY=${shq(checks)} bash scripts/test-all.sh` });
  steps.push({ name: 'words', why: 'words lint + check (GUARDRAILS-build.md)',
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

  // Each vitest package with a touched source file: its scanners, the tests naming a touched file, the touched tests.
  for (const pkg of VITEST_PACKAGES) {
    const mine = files.filter(f => f.startsWith(pkg.dir + '/') && SOURCE_EXT.test(f) && !/\/(node_modules|dist)\//.test(f));
    if (!mine.length) continue;
    const all = repo.tests(pkg.dir);
    const changedTests = mine.filter(f => TEST_FILE.test(f) && repo.exists(f));
    const sources = mine.filter(f => !TEST_FILE.test(f));
    const stems = [...new Set(sources.map(f => path.basename(f).replace(SOURCE_EXT, '')))].filter(s => s.length > 1);
    const exactName = stems.length
      ? new RegExp(`(^|[^\\w-])(${stems.map(esc).join('|')})\\.(tsx?|jsx?|mjs|cjs)\\b`) : null;
    const pathish = stems.length
      ? new RegExp(`[/'"\`](${stems.map(esc).join('|')})(\\.(tsx?|jsx?|mjs|cjs))?['"\`]`) : null;
    const colocated = new Set(sources.map(f => path.join(path.dirname(f), path.basename(f).replace(SOURCE_EXT, ''))));
    const scanners = [], pins = [], importers = [];
    for (const t of all) {
      const text = repo.read(t);
      const base = path.join(path.dirname(t), path.basename(t).replace(/(\.[\w-]+)*\.test\.\w+$/, ''));
      if (SCANNER.test(text)) scanners.push(t);
      else if (colocated.has(base) || (exactName && exactName.test(text))) pins.push(t);
      else if (pathish && pathish.test(text)) importers.push(t);
    }
    const core = new Set([...changedTests, ...scanners, ...pins]);
    const extra = importers.filter(t => !core.has(t));
    const keepImporters = core.size + extra.length <= MAX_TESTS_PER_PACKAGE;
    const chosen = [...core, ...(keepImporters ? extra : [])];
    if (!chosen.length) continue;
    const rel = chosen.map(t => path.relative(pkg.dir, t)).sort();
    const why = `${sources.length} source + ${changedTests.length} test file(s) touched in ${pkg.dir}: `
      + `${scanners.length} tree scanners, ${pins.length} pins/co-located, `
      + (keepImporters ? `${extra.length} importers` : `${extra.length} importers left to CI (over ${MAX_TESTS_PER_PACKAGE} tests)`);
    steps.push({ name: `vitest:${pkg.name}`, why,
      cmd: `${pkg.env ? pkg.env + ' ' : ''}pnpm --filter ${pkg.name} exec vitest run --maxWorkers=2 --passWithNoTests ${rel.map(shq).join(' ')}` });
  }

  // A guide page: the guide package's own tests (its pages build, versions and titles).
  if (files.some(f => f.startsWith('packages/beanpool-guide/content/'))) {
    steps.push({ name: 'guide', why: 'a guide page changed', cmd: 'pnpm --filter @beanpool/guide test' });
  }

  // A script with a sibling test test-all.sh does not name (those it names run in a check), or a touched script test.
  const scriptTests = new Set();
  for (const f of files) {
    if (!/^scripts\/.+\.m?js$/.test(f)) continue;
    const t = /\.test\.m?js$/.test(f) ? f : f.replace(/\.(m?js)$/, '.test.$1');
    if (repo.exists(t) && !repo.testAllText.includes(t)) scriptTests.add(t);
  }
  if (scriptTests.size) {
    const list = [...scriptTests].sort();
    steps.push({ name: 'script-tests', why: `script tests test-all.sh does not run: ${list.join(', ')}`,
      cmd: `node --test ${list.map(shq).join(' ')}` });
  }
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  try {
    const touched = opt('--diff') ? parseDiff(fs.readFileSync(opt('--diff'), 'utf8')) : touchedFromGit(opt('--base') || 'origin/main');
    for (const s of planSteps(touched, gitRepo())) {
      process.stdout.write(`${s.name}\t${s.why.replace(/[\t\n]/g, ' ')}\t${s.cmd}\n`);
    }
  } catch (e) {
    console.error(`preflight-plan: ${e.message}`);
    process.exit(2);
  }
}

// Shared by record.mjs and stress.sh (via record.mjs --seen): read failing tests out of a log, judge whether a PR's diff
// reached a test, and read/append the flake ledger. Pure functions over text and files; the only process this module
// starts is none. record.mjs is the one place that calls gh.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LEDGER = '/Users/marty/projects/beanpool/scratch/lanes/flakes.jsonl';
export const SECOND_HIT_DAYS = 14;

// ── Reading a log ──────────────────────────────────────────────────────────────────────────────────────────────────

// `gh run view --log-failed` puts "<job>\t<step>\t<ISO time> " before every line, and prints a colour code as the two
// characters ^[ rather than ESC. A raw local log has neither.
const GH_PREFIX = /^[^\t\n]*\t[^\t\n]*\t\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
// eslint-disable-next-line no-control-regex -- ESC is exactly what a raw log carries
const ANSI = /(?:\x1b|\^\[)\[[0-9;]*[A-Za-z]/g;

export function cleanLine(raw) {
    return raw.replace(GH_PREFIX, '').replace(ANSI, '').replace(/\r/g, '').replace(/^\uFEFF/, '');
}

/** One name per test however often a log repeats it: colour, spacing and a trailing vitest duration are not identity. */
export function normTest(name) {
    return String(name ?? '').replace(ANSI, '').replace(/\s+\d+(?:\.\d+)?m?s$/, '').replace(/\s+/g, ' ').trim();
}

const SUITE_ENTRY = /^(test-[a-z0-9-]+)(?:\s*\([^)]*\))?: (?:✗|❌)/;
const ROLLUP = /^❌ .*suites failed:\s*(.*)$/;
const serverFile = (id) => `apps/server/src/${id}.ts`;

/**
 * Failing tests named in a log: a CI job's (test-all's report) or one local run's output. Returns
 * [{ test, kind, check, file, pkg }] where `file` is repo-relative when the log says which file (else null) and `pkg`
 * is the turbo package a vitest name came from (its path is package-relative until resolveFiles maps it).
 *
 * What it reads, in order of trust:
 *   1. test-all's `── Failing tests (N) ──` block (scripts/test-all-lib.sh failing_tests_summary), which already names
 *      each vitest `file > suite > test` and each server suite `test-x: ✗ <assertion>`.
 *   2. With no block for a failed check: vitest ` FAIL  file > test` lines, node --test `not ok N - name` lines, and
 *      `✗` lines under a `━━━ test-x ━━━` header.
 *   3. A failed check (`║  name  ❌ FAIL`) that names no test at all: one entry for the check, with the first repo
 *      file its stack points at, so a red check is still on the ledger.
 */
export function parseFailures(text) {
    const lines = text.split('\n').map(cleanLine);
    const failedChecks = new Set();
    for (const l of lines) {
        const m = /^║\s+([a-z0-9_]+)\s+❌ FAIL/.exec(l.trim());
        if (m) failedChecks.add(m[1]);
    }
    // Split the Failure Details into one section per failed check; a log with no report is one section.
    const sections = [];
    let cur = { check: null, lines: [] };
    let inDetails = false;
    for (const l of lines) {
        const t = l.trim();
        if (/^──── Failure Details ────$/.test(t)) { inDetails = true; continue; }
        const h = /^━━━\s*(.+?)\s*━━━$/.exec(t);
        if (inDetails && h && failedChecks.has(h[1])) {
            if (cur.lines.length || cur.check) sections.push(cur);
            cur = { check: h[1], lines: [] };
            continue;
        }
        cur.lines.push(l);
    }
    sections.push(cur);
    if (!failedChecks.size) sections.splice(0, sections.length, { check: null, lines });

    const out = [];
    const seen = new Set();
    const add = (e) => {
        const k = normTest(e.test);
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push({ ...e, test: k });
    };
    const named = new Set();
    for (const s of sections) {
        const before = out.length;
        readSummaryBlocks(s, add);
        if (out.length === before) readRawLines(s, add);
        if (out.length > before && s.check) named.add(s.check);
    }
    for (const check of failedChecks) {
        if (named.has(check)) continue;
        const s = sections.find((x) => x.check === check);
        add({ test: `${check} (check failed; no test named in the log)`, kind: 'check', check, file: stackFile(s?.lines ?? []), pkg: null });
    }
    return out;
}

function classify(entry, check, pkg) {
    const suite = SUITE_ENTRY.exec(entry);
    if (suite) return { test: entry, kind: 'server-suite', check, file: serverFile(suite[1]), pkg: null };
    const roll = ROLLUP.exec(entry);
    if (roll) return roll[1].split(/\s+/).filter(Boolean).map((n) => {
        const id = n.replace(/\(.*\)$/, '');
        return { test: `${n}: the whole suite failed`, kind: 'server-suite', check, file: /^test-[a-z0-9-]+$/.test(id) ? serverFile(id) : null, pkg: null };
    });
    const gt = entry.indexOf(' > ');
    if (gt > 0) return { test: entry, kind: 'vitest', check, file: entry.slice(0, gt).trim(), pkg };
    return { test: entry, kind: 'check', check, file: null, pkg: null };
}

// The block is `── Failing tests (N) ──`, then N entries at two spaces (each maybe followed by its error at six), and
// then, with no separator, the task's tail, whose own lines can start with two spaces too. So the header's N, not the
// indent, ends the block.
function readSummaryBlocks(section, add) {
    let pkg = null;
    let left = 0;
    for (const l of section.lines) {
        const t = l.trim();
        const task = /^── (\S+)#\S+(?: \(.*\))? ──$/.exec(t);
        if (task) { pkg = task[1]; left = 0; continue; }
        const head = /^── Failing tests \((\d+)\) ──$/.exec(t);
        if (head) { left = Number(head[1]); continue; }
        if (!left) continue;
        if (/^ {6}/.test(l)) continue;                                   // the entry's error line
        if (/^ {2}\S/.test(l) && !/^ {2}… and \d+ more$/.test(l)) {
            [classify(t, section.check, pkg)].flat().forEach(add);
            left--;
        } else {
            left = 0;
        }
    }
}

function readRawLines(section, add) {
    let suite = null;
    for (const l of section.lines) {
        const t = l.trim();
        const h = /^━━━\s*(.+?)\s*━━━$/.exec(t);
        if (h) { suite = h[1]; continue; }
        let m;
        if ((m = /^FAIL\s+(.+ > .+)$/.exec(t))) add(classify(m[1].trim(), section.check, null));
        else if ((m = /^not ok \d+ - (.+?)(?:\s+#.*)?$/.exec(t))) add({ test: m[1], kind: 'node-test', check: section.check, file: null, pkg: null });
        else if (/^✗/.test(t)) {
            const name = suite && !t.includes(suite) ? `${suite}: ${t}` : t;
            add(classify(name, section.check, null));
        } else if (ROLLUP.test(t)) [classify(t, section.check, null)].flat().forEach(add);
    }
}

/** The first file of this repository a stack line in the section points at (CI checks out to .../beanpool/beanpool/). */
function stackFile(lines) {
    for (const l of lines) {
        const m = /file:\/\/\/\S*?\/beanpool\/beanpool\/([^\s:)]+)/.exec(l) || /\(\/\S*?\/beanpool\/beanpool\/([^\s:)]+)/.exec(l);
        if (m && !m[1].includes('node_modules/')) return m[1];
    }
    return null;
}

// ── The workspace ──────────────────────────────────────────────────────────────────────────────────────────────────

/** name -> { dir, deps } for every apps/* and packages/* package (pnpm-workspace.yaml's globs). */
export function workspace(root) {
    const map = new Map();
    for (const top of ['apps', 'packages']) {
        let names;
        try { names = fs.readdirSync(path.join(root, top)); } catch { continue; }
        for (const n of names) {
            const pj = path.join(root, top, n, 'package.json');
            try {
                const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
                if (!j.name) continue;
                const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
                map.set(j.name, { dir: `${top}/${n}`, deps });
            } catch { /* not a package */ }
        }
    }
    return map;
}

/** Maps each entry's package-relative vitest path to a repo path, using its turbo package, else a unique match. */
export function resolveFiles(root, entries, ws = workspace(root)) {
    return entries.map((e) => {
        if (!e.file || fs.existsSync(path.join(root, e.file)) && !e.pkg) return e;
        const dirs = e.pkg && ws.has(e.pkg) ? [ws.get(e.pkg).dir] : [...ws.values()].map((p) => p.dir);
        const hits = dirs.map((d) => `${d}/${e.file}`).filter((f) => fs.existsSync(path.join(root, f)));
        if (hits.length === 1) return { ...e, file: hits[0] };
        if (e.pkg && ws.has(e.pkg)) return { ...e, file: `${ws.get(e.pkg).dir}/${e.file}` };
        return e;
    });
}

// ── Did the diff reach the test? ────────────────────────────────────────────────────────────────────────────────────

const SPEC = [
    /(?:^|[^.\w$])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/g,
    /(?:^|[^.\w$])import\s*['"]([^'"\n]+)['"]/g,
    /(?:^|[^.\w$])(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];
const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json', '.native.ts', '.native.tsx', '.web.ts', '.web.tsx'];
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function resolveRel(abs) {
    for (const ext of EXTS) if (isFile(abs + ext)) return abs + ext;
    const swapped = abs.replace(/\.(m|c)?js$/, '');
    if (swapped !== abs) for (const ext of EXTS.slice(1)) if (isFile(swapped + ext)) return swapped + ext;
    for (const ext of EXTS.slice(1)) if (isFile(path.join(abs, 'index' + ext))) return path.join(abs, 'index' + ext);
    return null;
}

/** tsconfig "paths" wildcard aliases of a package ("@/*": ["./src/*"]), read without a JSON-with-comments parser. */
function aliases(root, pkgDir) {
    try {
        const s = fs.readFileSync(path.join(root, pkgDir, 'tsconfig.json'), 'utf8');
        const block = /"paths"\s*:\s*\{([^}]*)\}/.exec(s)?.[1] ?? '';
        return [...block.matchAll(/"([^"*]+)\*"\s*:\s*\[\s*"([^"*]+)\*"/g)].map((m) => ({ from: m[1], to: path.join(pkgDir, m[2]) }));
    } catch { return []; }
}

const pkgOf = (ws, rel) => [...ws.entries()].find(([, p]) => rel === p.dir || rel.startsWith(p.dir + '/'));
const isTestPath = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /\/__tests__\//.test(f) || /^apps\/server\/src\/test-[^/]+\.ts$/.test(f);

/**
 * Whether `diffFiles` reached `testFile`, and how that was judged. Returns { touched, via, judge }:
 *   file     the diff changes the test file itself
 *   import   it changes a file the test imports, followed transitively through relative and tsconfig-alias imports
 *   package  it changes a non-test file of a workspace package the test (or a file it imports) imports by name; a
 *            server suite starts the server, so apps/server and the workspace packages it depends on count as imported
 *   config   it changes the test's package.json, its vitest/vite config, or pnpm-lock.yaml
 *   not-seen none of those. NOT proof the PR is innocent: dynamic and computed imports, spawned processes, fixtures read
 *            from disk, the environment and shared state are not followed
 *   unknown  the log named no file, or the file is not in this checkout
 * Imports are read from this checkout, not from the PR's head.
 */
export function judgeTouch(root, testFile, diffFiles, { kind = null, ws = workspace(root), maxFiles = 4000 } = {}) {
    const diff = new Set(diffFiles);
    const how = 'static imports read from this checkout (relative, tsconfig aliases, workspace packages by name)';
    if (!testFile) return { touched: 'unknown', via: null, judge: 'the log names no file' };
    if (diff.has(testFile)) return { touched: 'file', via: testFile, judge: 'the diff changes the test file' };
    if (!isFile(path.join(root, testFile))) return { touched: 'unknown', via: null, judge: 'the test file is not in this checkout' };

    const home = pkgOf(ws, testFile);
    const cfg = [...diff].find((f) => f === 'pnpm-lock.yaml'
        || (home && (f === `${home[1].dir}/package.json` || new RegExp(`^${home[1].dir}/vite(st)?\\.config\\.`).test(f))));
    if (cfg) return { touched: 'config', via: cfg, judge: 'the diff changes the test\'s package config or the lockfile' };

    const pkgs = new Set();
    if (kind === 'server-suite' || /^apps\/server\/src\/test-[^/]+\.ts$/.test(testFile)) {
        for (const [name, p] of ws) if (p.dir === 'apps/server') { pkgs.add(name); p.deps.forEach((d) => ws.has(d) && pkgs.add(d)); }
    }
    const seen = new Set([testFile]);
    const queue = [testFile];
    while (queue.length && seen.size < maxFiles) {
        const rel = queue.shift();
        let src;
        try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
        const owner = pkgOf(ws, rel);
        const al = owner ? aliases(root, owner[1].dir) : [];
        for (const re of SPEC) {
            for (const m of src.matchAll(re)) {
                const spec = m[1];
                let abs;
                if (spec.startsWith('.')) abs = path.resolve(root, path.dirname(rel), spec);
                else {
                    const a = al.find((x) => spec.startsWith(x.from));
                    if (a) abs = path.join(root, a.to, spec.slice(a.from.length));
                    else {
                        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
                        if (ws.has(name)) pkgs.add(name);
                        continue;
                    }
                }
                const hit = resolveRel(abs);
                if (!hit) continue;
                const r = path.relative(root, hit);
                if (r.startsWith('..') || r.includes('node_modules')) continue;
                if (diff.has(r)) return { touched: 'import', via: r, judge: `the test imports ${r}, which the diff changes (${how})` };
                if (!seen.has(r)) { seen.add(r); queue.push(r); }
            }
        }
    }
    for (const name of pkgs) {
        const dir = ws.get(name).dir + '/';
        const f = [...diff].find((x) => x.startsWith(dir) && !isTestPath(x));
        if (f) return { touched: 'package', via: f, judge: `the test uses ${name}, and the diff changes ${f} in it (${how})` };
    }
    return {
        touched: 'not-seen', via: null,
        judge: `no changed file among ${seen.size} files and ${pkgs.size} workspace packages reached by ${how}; `
            + 'dynamic imports, spawned processes, fixtures, env and shared state are not followed, so this is no proof',
    };
}

// ── The ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────

export function readLedger(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function appendLedger(file, entries) {
    if (!entries.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
}

export const identity = (e) => `${e.file ?? ''}|${normTest(e.test)}`;
export const recordKey = (e) => `${e.run}|${e.job}|${identity(e)}`;

/**
 * Earlier hits of the same test on OTHER PRs within `days` of this one (either side, so a late record still pairs).
 * `sameFile` is the weaker sibling: a different test in the same file, also on another PR.
 */
export function earlierHits(ledger, entry, days = SECOND_HIT_DAYS) {
    const t = Date.parse(entry.time);
    const near = (e) => Number.isFinite(t) && Math.abs(Date.parse(e.time) - t) <= days * 86400e3;
    const others = ledger.filter((e) => String(e.pr) !== String(entry.pr) && near(e));
    const id = identity(entry);
    const same = others.filter((e) => identity(e) === id);
    const sameFile = entry.file ? others.filter((e) => e.file === entry.file && identity(e) !== id) : [];
    return { same, sameFile };
}

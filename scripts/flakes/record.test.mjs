// record.mjs and lib.mjs against captured CI job logs (scripts/flakes/fixtures, from `gh run view --job <id>
// --log-failed`, abridged at one marked point each), a made-up tree and diff, and a fake `gh` on PATH that serves
// them and logs every call. Each rule has a check, and a MUTANT: a copy of the scripts with that rule broken, which
// the same check must reject, so no check here can pass by proving nothing.
//   node --test scripts/flakes/record.test.mjs        (test-all.sh's flake_tools check)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `flake-${p}-`));
const write = (root, rel, text = '') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

/** A small workspace: a package by name, an app that imports it, a server app, and tests with relative imports. */
function makeTree() {
    const root = tmp('tree');
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@x/core' }));
    write(root, 'packages/core/src/a.ts', 'export const a = 1;\n');
    write(root, 'packages/core/src/a.test.ts', "import { a } from './a';\n");
    write(root, 'apps/web/package.json', JSON.stringify({ name: '@x/web', dependencies: { '@x/core': 'workspace:*' } }));
    write(root, 'apps/web/tsconfig.json', '{ "compilerOptions": { // comments are allowed here\n "paths": { "@/*": ["./src/*"] } } }\n');
    write(root, 'apps/web/src/b.ts', "import { c } from './c.js';\nexport { c };\n");
    write(root, 'apps/web/src/c.ts', "import {\n  a,\n} from '@x/core';\nexport const c = a;\n");
    write(root, 'apps/web/src/d.ts', 'export const d = 4;\n');
    write(root, 'apps/web/src/b.test.ts', "import { c } from './b';\nimport { d } from '@/d';\n");
    write(root, 'apps/server/package.json', JSON.stringify({ name: '@x/server', dependencies: { '@x/core': 'workspace:*' } }));
    write(root, 'apps/server/src/index.ts', 'export {};\n');
    write(root, 'apps/server/src/test-alerts.ts', "import fs from 'node:fs';\n");
    write(root, 'apps/pwa/package.json', JSON.stringify({ name: '@beanpool/pwa' }));
    return root;
}

/** A copy of lib.mjs + record.mjs (+ stress.sh) with `from` replaced by `to` in `file`; `from` must occur exactly once. */
function mutate(file, from, to) {
    const dir = tmp('mutant');
    for (const f of ['lib.mjs', 'record.mjs', 'stress.sh']) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
    const p = path.join(dir, file);
    const src = fs.readFileSync(p, 'utf8');
    assert.equal(src.split(from).length - 1, 1, `the mutant's text must occur once in ${file}: ${from}`);
    fs.writeFileSync(p, src.replace(from, to));
    return dir;
}
const load = async (dir) => ({ lib: await import(pathToFileURL(path.join(dir, 'lib.mjs'))), rec: await import(pathToFileURL(path.join(dir, 'record.mjs'))) });

// ── The fake gh ─────────────────────────────────────────────────────────────────────────────────────────────────────
const BIN = tmp('bin');
fs.writeFileSync(path.join(BIN, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_CALLS, JSON.stringify(a) + '\\n');
const c = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CONFIG, 'utf8'));
const out = (x) => process.stdout.write(typeof x === 'string' ? x : JSON.stringify(x));
if (a[0] === 'pr' && a[1] === 'view') out(c.pr);
else if (a[0] === 'pr' && a[1] === 'diff') out(c.prDiff.join('\\n') + '\\n');
else if (a[0] === 'run' && a[1] === 'list') out(c.runs);
else if (a[0] === 'run' && a[1] === 'view' && a[2] === '--job') out(fs.readFileSync(c.logs[a[3]], 'utf8'));
else if (a[0] === 'run' && a[1] === 'view' && a.includes('jobs')) out({ jobs: c.jobs[a[2]] });
else if (a[0] === 'run' && a[1] === 'view') out(c.runs.find((r) => String(r.databaseId) === a[2]));
else if (a[0] === 'api' && c.compare) out(c.compare.join('\\n') + '\\n');
else { process.stderr.write('fake gh: no answer for ' + a.join(' ')); process.exit(1); }
`, { mode: 0o755 });

const AGG = path.join(BIN, 'aggregate.log');
fs.writeFileSync(AGG, 'Run BeanPool Test-All Pipeline\tEvery shard passed\t2026-11-14T18:40:00.0000000Z Shards: failure\n');

/** One PR with one failing server shard (and the aggregate job, whose log names no test). */
function scenario({ pr, run, job, completedAt, log = 'ci-server-suite.txt', compare = [] }) {
    return {
        pr: { number: pr, headRefOid: `${pr}`.padEnd(40, 'a'), headRefName: `feat/pr-${pr}`, baseRefName: 'main' },
        runs: [
            { databaseId: run + 1, headSha: `${pr}`.padEnd(40, 'a'), conclusion: 'success', event: 'pull_request' },
            { databaseId: run, headSha: `${pr}`.padEnd(40, 'a'), conclusion: 'failure', event: 'pull_request' },
        ],
        jobs: { [run]: [
            { databaseId: job, name: 'Test-All shard server-1', conclusion: 'failure', completedAt },
            { databaseId: job + 1, name: 'Run BeanPool Test-All Pipeline', conclusion: 'failure', completedAt },
            { databaseId: job + 2, name: 'Test-All shard vitest-rest', conclusion: 'success', completedAt },
        ] },
        logs: { [job]: path.join(FIX, log), [job + 1]: AGG },
        compare, prDiff: compare,
    };
}

function runRecord(dir, args, cfg, env) {
    const cfgFile = path.join(env.WORK, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const r = spawnSync(process.execPath, [path.join(dir, 'record.mjs'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_CONFIG: cfgFile, FAKE_GH_CALLS: env.CALLS, FLAKE_LEDGER: env.LEDGER, FLAKE_ROOT: env.ROOT },
    });
    return { out: r.stdout + r.stderr, code: r.status };
}

// ── The rules: each a check over a loaded copy of the scripts ──────────────────────────────────────────────────────

const RULES = {
    // The summary block ends after its N entries: the task tail that follows it starts with two spaces too.
    'summary block bounded by its count': async ({ lib }) => {
        const e = lib.parseFailures(fixture('ci-vitest.txt'));
        assert.deepEqual(e.map((x) => x.kind), ['vitest'], JSON.stringify(e.map((x) => x.test)));
        assert.match(e[0].test, /^src\/pages\/EnterpriseNotAProfile\.test\.tsx > every door on the web/);
        const r = lib.resolveFiles(makeTree(), e);
        assert.equal(r[0].file, 'apps/pwa/src/pages/EnterpriseNotAProfile.test.tsx', 'the turbo task header names the package');
    },
    'a server suite check is tagged with its suite file': async ({ lib }) => {
        const e = lib.parseFailures(fixture('ci-server-suite.txt'));
        assert.equal(e.length, 1, JSON.stringify(e));
        assert.equal(e[0].test, 'test-alerts: ✗ 11. once it stays down 15 minutes: resolved, told once');
        assert.equal(e[0].file, 'apps/server/src/test-alerts.ts');
        assert.equal(e[0].check, 'server_suites');
    },
    'a failed check that names no test is still recorded, with its stack file': async ({ lib }) => {
        const e = lib.parseFailures(fixture('ci-node-test.txt'));
        assert.equal(e.length, 1, JSON.stringify(e));
        assert.equal(e[0].kind, 'check');
        assert.equal(e[0].check, 'no_google_fonts');
        assert.equal(e[0].file, 'scripts/no-google-fonts.test.mjs');
    },
    'imports are followed transitively, .js naming the .ts': async ({ lib }) => {
        const root = makeTree();
        const t = lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['apps/web/src/c.ts']);
        assert.equal(t.touched, 'import', t.judge);
        assert.equal(t.via, 'apps/web/src/c.ts');
        assert.equal(lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['apps/web/src/d.ts']).touched, 'import', 'a tsconfig alias is followed');
    },
    'a package counts by its non-test files only': async ({ lib }) => {
        const root = makeTree();
        assert.equal(lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['packages/core/src/a.ts']).touched, 'package');
        const t = lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['packages/core/src/a.test.ts']);
        assert.equal(t.touched, 'not-seen', t.judge);
        assert.match(t.judge, /no proof/);
    },
    'a server suite counts the server and its packages as imported': async ({ lib }) => {
        const root = makeTree();
        assert.equal(lib.judgeTouch(root, 'apps/server/src/test-alerts.ts', ['apps/server/src/index.ts'], { kind: 'server-suite' }).touched, 'package');
        assert.equal(lib.judgeTouch(root, 'apps/server/src/test-alerts.ts', ['packages/core/src/a.ts'], { kind: 'server-suite' }).touched, 'package');
    },
    'the lockfile and the package config touch every test of the package': async ({ lib }) => {
        const root = makeTree();
        assert.equal(lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['pnpm-lock.yaml']).touched, 'config');
        assert.equal(lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['apps/web/package.json']).touched, 'config');
        assert.equal(lib.judgeTouch(root, 'apps/web/src/b.test.ts', ['apps/web/src/b.test.ts']).touched, 'file');
        assert.equal(lib.judgeTouch(root, 'apps/web/src/gone.test.ts', ['x']).touched, 'unknown');
        assert.equal(lib.judgeTouch(root, null, ['x']).touched, 'unknown');
    },
    'gh is only ever read': async ({ rec }) => {
        for (const bad of [['run', 'rerun', '1'], ['run', 'cancel', '1'], ['pr', 'merge', '1'], ['pr', 'comment', '1'],
            ['workflow', 'run', 'ci.yml'], ['api', '-X', 'POST', 'x'], ['api', 'x', '-f', 'a=b'], ['api', '--method=PATCH', 'x']]) {
            assert.throws(() => rec.assertReadOnly(bad), /refus/, bad.join(' '));
        }
        for (const ok of [['pr', 'view', '1'], ['pr', 'diff', '1'], ['run', 'list'], ['run', 'view', '1'], ['api', 'repos/{owner}/{repo}/compare/main...x'],
            ['api', 'x', '--jq', '.files[].filename'], ['api', 'x', '--paginate', '-q', '.x'], ['api', 'x', '--include']]) {
            rec.assertReadOnly(ok);
        }
    },
    // gh's flag parser takes a value glued to its flag (`gh api -XGET x` works) and short flags in a cluster.
    'gh api: a write flag with its value attached is refused too': async ({ rec }) => {
        for (const flag of ['-XPOST', '-fk=v', '-Fk=v', '--raw-field=k=v', '--method=POST', '--field=k=v', '--input=body.json', '-iXPOST', '-iF', '--raw-field', '--input']) {
            assert.throws(() => rec.assertReadOnly(['api', 'x', flag]), /refuses a gh api call that can write/, flag);
        }
    },
    // The pairing table: every record shape against every other, so no shape can pair by accident (14 Nov: #3148 and
    // #3153 each failed pwa_dark_classes on their own new component, and the first cut paired them as SECOND-HIT).
    'only the same named test pairs; a failed check that names no test pairs with nothing': async ({ lib }) => {
        const F = 'scripts/demo.test.mjs';
        const S = {
            named: { test: 'test-alerts: ✗ 11. resolved, told once', file: F, kind: 'server-suite', check: 'server_suites' },
            namedSibling: { test: 'test-alerts: ✗ 12. told twice', file: F, kind: 'server-suite', check: 'server_suites' },
            nodeTest: { test: 'a member sees the bell once', file: F, kind: 'node-test', check: 'demo_check' },
            nameOnly: { test: 'a quote keeps its author', file: null, kind: 'node-test', check: 'demo_check' },
            fileOnly: { test: `${lib.NO_TEST}no_google_fonts`, file: F, kind: 'check', check: 'no_google_fonts' },
            fileOnlySibling: { test: `${lib.NO_TEST}merge_gate`, file: F, kind: 'check', check: 'merge_gate' },
            checkOnly: { test: `${lib.NO_TEST}pwa_dark_classes`, file: null, kind: 'check', check: 'pwa_dark_classes' },
            checkOnlyOutput: { test: 'secrets_guard: ❌ Error: found a key', file: null, kind: 'check', check: 'secrets_guard' },
        };
        const named = (k) => S[k].kind !== 'check';
        const day = 86400e3;
        const t0 = Date.parse('2026-11-10T10:00:00Z');
        const at = (ms) => new Date(t0 + ms).toISOString();
        for (const a of Object.keys(S)) {
            for (const b of Object.keys(S)) {
                const before = { ...S[a], pr: 1, run: 1, job: 1, time: at(0) };
                const now = { ...S[b], pr: 2, run: 2, job: 2, time: at(day) };
                const h = lib.earlierHits([before], now);
                const wantSame = a === b && named(a) ? 1 : 0;
                const wantFile = a !== b && named(a) && named(b) && S[a].file && S[a].file === S[b].file ? 1 : 0;
                assert.equal(h.same.length, wantSame, `${a} then ${b}: SECOND-HIT ${h.same.length}, want ${wantSame}`);
                assert.equal(h.sameFile.length, wantFile, `${a} then ${b}: same file ${h.sameFile.length}, want ${wantFile}`);
                assert.equal(lib.earlierHits([{ ...before, pr: 2 }], now).same.length, 0, `${a} then ${b} on the same PR`);
                assert.equal(lib.earlierHits([{ ...before, time: at(-28 * day) }], now).same.length, 0, `${a} then ${b} 29 days apart`);
            }
        }
        // The real logs: each PR's own contrast red, a different component each, parse to one check-only record each.
        const [p1, p2] = ['ci-check-no-test-1.txt', 'ci-check-no-test-2.txt'].map((n) => lib.parseFailures(fixture(n)));
        assert.deepEqual(p1.map((e) => [e.kind, e.check, e.test]), [['check', 'pwa_dark_classes', `${lib.NO_TEST}pwa_dark_classes`]]);
        assert.deepEqual(p2.map((e) => [e.kind, e.check]), [['check', 'pwa_dark_classes']]);
        assert.equal(lib.earlierHits([{ ...p1[0], pr: 3148, time: at(0) }], { ...p2[0], pr: 3153, time: at(day / 24) }).same.length, 0);
    },
    // The same two real logs through the CLI: recorded, said as a check red, never a SECOND-HIT.
    'two PRs\' own check reds are recorded as "check red, no test named", never SECOND-HIT': async (_m, dir) => {
        const WORK = tmp('work');
        const env = { WORK, CALLS: path.join(WORK, 'calls'), LEDGER: path.join(WORK, 'flakes.jsonl'), ROOT: makeTree() };
        let r = runRecord(dir, ['3148'], scenario({ pr: 3148, run: 9300, job: 7300, completedAt: '2026-11-14T13:10:00Z', log: 'ci-check-no-test-1.txt' }), env);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /^ {2}recorded {2}check red, no test named: pwa_dark_classes {2}\[no file; touched=unknown\]; never counted toward a second hit$/m, r.out);
        r = runRecord(dir, ['3153'], scenario({ pr: 3153, run: 9400, job: 7400, completedAt: '2026-11-14T14:15:00Z', log: 'ci-check-no-test-2.txt' }), env);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /^ {2}recorded {2}check red, no test named: pwa_dark_classes /m, r.out);
        assert.doesNotMatch(r.out, /SECOND-HIT/, r.out);
        const lines = fs.readFileSync(env.LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.deepEqual(lines.map((e) => [e.pr, e.kind, e.check]), [[3148, 'check', 'pwa_dark_classes'], [3153, 'check', 'pwa_dark_classes']]);
    },
    // On CI node --test prints TAP: `not ok N - name`, then a YAML block whose `location:` names the file. A describe
    // that failed only through a child prints its own `not ok` with failureType 'subtestsFailed': not a failure of its own.
    'node --test on CI: each failed test with its file, never the describe around it': async ({ lib }) => {
        const e = lib.parseFailures(fixture('ci-node-test-named.txt'));
        assert.deepEqual(e.map((x) => [x.test, x.kind, x.file, x.check]), [
            ['a member sees the bell once', 'node-test', 'scripts/demo.test.mjs', 'demo_check'],
            ['a quote keeps its author', 'node-test', 'scripts/demo.test.mjs', 'demo_check'],
        ]);
    },
    // On this Mac (node v26) a node --test run logged to a file prints the spec reporter: `✖ name (1.2ms)`, and at the
    // end a `✖ failing tests:` list of the failed tests themselves (a describe's own `✖` is above it).
    'node v26 spec output is read, so SEEN-ON-CI fires for a node --test file': async ({ lib, rec }) => {
        // stress.sh hands over its red runs joined into one log, so the second run's describe line comes after a list.
        const local = fixture('local-node26-spec.txt') + fixture('local-node26-spec.txt');
        assert.deepEqual(lib.parseFailures(local).map((x) => [x.test, x.kind]), [
            ['a member sees the bell once', 'node-test'], ['a quote keeps its author', 'node-test'],
        ]);
        const WORK = tmp('seen26');
        const ledger = path.join(WORK, 'l.jsonl');
        const ci = lib.parseFailures(fixture('ci-node-test-named.txt')).map((x, i) => ({ ...x, pr: 50 + i, run: 5, time: '2026-11-14T20:03:50Z', touched: 'not-seen' }));
        fs.writeFileSync(ledger, ci.map((x) => JSON.stringify(x)).join('\n') + '\n');
        const said = [];
        rec.seen({ file: 'scripts/demo.test.mjs', logText: local, ledgerPath: ledger, now: new Date('2026-11-15T00:00:00Z'), log: (s) => said.push(s) });
        assert.match(said.join('\n'), /^SEEN-ON-CI PR #50 2026-11-14 run 5: a member sees the bell once/m, said.join('\n'));
        assert.match(said.join('\n'), /^SEEN-ON-CI PR #51 2026-11-14 run 5: a quote keeps its author/m);
    },
    // The ledger end to end, through the CLI and the fake gh.
    'the ledger: once per job, SECOND-HIT only on another PR within 14 days': async (_m, dir) => {
        const WORK = tmp('work');
        const env = { WORK, CALLS: path.join(WORK, 'calls'), LEDGER: path.join(WORK, 'sub', 'flakes.jsonl'), ROOT: makeTree() };
        const lines = () => fs.readFileSync(env.LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

        let r = runRecord(dir, ['101'], scenario({ pr: 101, run: 9001, job: 7001, completedAt: '2026-11-10T10:00:00Z', compare: ['apps/server/src/test-alerts.ts'] }), env);
        assert.equal(r.code, 0, r.out);
        assert.match(r.out, /^PR #101 run 9001 \(head 101aaaa\): 2 failed job\(s\); diff 1 file\(s\)$/m, 'the CLI ran and picked the failed run');
        assert.doesNotMatch(r.out, /SECOND-HIT/);
        assert.match(r.out, /Run BeanPool Test-All Pipeline: no failing test named/);
        assert.equal(lines().length, 1);
        const first = lines()[0];
        assert.deepEqual(
            { test: first.test, file: first.file, pr: first.pr, run: first.run, job: first.job, touched: first.touched, time: first.time },
            { test: 'test-alerts: ✗ 11. once it stays down 15 minutes: resolved, told once', file: 'apps/server/src/test-alerts.ts', pr: 101, run: 9001, job: 7001, touched: 'file', time: '2026-11-10T10:00:00Z' });
        assert.equal(first.head, '101'.padEnd(40, 'a'));

        r = runRecord(dir, ['101'], scenario({ pr: 101, run: 9001, job: 7001, completedAt: '2026-11-10T10:00:00Z' }), env);
        assert.equal(lines().length, 1, 'a second call for the same run and job appends nothing');
        assert.match(r.out, /1 already on the ledger/);

        r = runRecord(dir, ['101', '9002'], scenario({ pr: 101, run: 9002, job: 7003, completedAt: '2026-11-11T10:00:00Z' }), env);
        assert.equal(lines().length, 2);
        assert.doesNotMatch(r.out, /SECOND-HIT/, 'the same PR failing again is not a second hit');

        r = runRecord(dir, ['202'], scenario({ pr: 202, run: 9100, job: 7100, completedAt: '2026-11-12T10:00:00Z', compare: ['docs/notes.md'] }), env);
        assert.match(r.out, /^SECOND-HIT test-alerts: ✗ 11\. once it stays down 15 minutes: resolved, told once \| apps\/server\/src\/test-alerts\.ts \| now PR #202 \(touched=not-seen\) \| before PR #101 2026-11-10 run 9001 \(touched=file\)/m);

        r = runRecord(dir, ['303'], scenario({ pr: 303, run: 9200, job: 7200, completedAt: '2026-12-10T10:00:00Z' }), env);
        assert.doesNotMatch(r.out, /SECOND-HIT/, '28 days after the last hit is not within 14');
        assert.equal(lines().length, 4);

        const calls = fs.readFileSync(env.CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        for (const c of calls) assert.ok(['pr view', 'pr diff', 'run list', 'run view'].includes(c.slice(0, 2).join(' ')) || c[0] === 'api', c.join(' '));
        assert.ok(!calls.some((c) => c.some((x) => /rerun|cancel|merge/.test(x))));
    },
    'stress cross-check: SEEN-ON-CI only for the same test': async ({ rec }) => {
        const WORK = tmp('seen');
        const ledger = path.join(WORK, 'l.jsonl');
        const now = new Date('2026-11-15T00:00:00Z');
        fs.writeFileSync(ledger, JSON.stringify({ test: 'src/x.test.ts > Group > drops a frame', file: 'apps/web/src/x.test.ts', pr: 7, run: 1, time: '2026-11-14T00:00:00Z', touched: 'not-seen' }) + '\n');
        const said = [];
        rec.seen({ file: 'apps/web/src/x.test.ts', logText: ' FAIL  src/x.test.ts > Group > drops a frame\nAssertionError: no\n', ledgerPath: ledger, now, log: (s) => said.push(s) });
        assert.match(said.join('\n'), /^SEEN-ON-CI PR #7 2026-11-14 run 1: src\/x\.test\.ts > Group > drops a frame/m);
        said.length = 0;
        rec.seen({ file: 'apps/web/src/x.test.ts', logText: ' FAIL  src/x.test.ts > Group > another test\n', ledgerPath: ledger, now, log: (s) => said.push(s) });
        assert.doesNotMatch(said.join('\n'), /SEEN-ON-CI/);
        assert.match(said.join('\n'), /^same file on CI PR #7/m);
        // A check red that named no test is never SEEN-ON-CI, even when the local log's own check red reads the same.
        fs.writeFileSync(ledger, JSON.stringify({ test: 'check red, no test named: unit', kind: 'check', check: 'unit', file: 'apps/web/src/x.test.ts', pr: 8, run: 3, time: '2026-11-14T00:00:00Z', touched: 'unknown' }) + '\n');
        said.length = 0;
        rec.seen({ file: 'apps/web/src/x.test.ts', logText: '║  unit             ❌ FAIL  3s\n', ledgerPath: ledger, now, log: (s) => said.push(s) });
        assert.doesNotMatch(said.join('\n'), /SEEN-ON-CI/, said.join('\n'));
        assert.match(said.join('\n'), /^same file on CI PR #8 2026-11-14 run 3: check red, no test named: unit/m);
    },
};

// Each mutant breaks exactly the rule it is named for.
const MUTANTS = [
    ['summary block bounded by its count', 'lib.mjs', 'if (head) { left = Number(head[1]); continue; }', 'if (head) { left = Infinity; continue; }'],
    ['a server suite check is tagged with its suite file', 'lib.mjs', 'const SUITE_ENTRY = /^(test-', 'const SUITE_ENTRY = /^(never-'],
    ['a failed check that names no test is still recorded, with its stack file', 'lib.mjs', 'if (named.has(check)) continue;', 'continue;'],
    ['imports are followed transitively, .js naming the .ts', 'lib.mjs', "const swapped = abs.replace(/\\.(m|c)?js$/, '');", 'const swapped = abs;'],
    ['imports are followed transitively, .js naming the .ts', 'lib.mjs', 'if (!seen.has(r)) { seen.add(r); queue.push(r); }', 'if (!seen.has(r)) { seen.add(r); }'],
    ['a package counts by its non-test files only', 'lib.mjs', "x.startsWith(dir) && !isTestPath(x)", 'x.startsWith(dir)'],
    ['a server suite counts the server and its packages as imported', 'lib.mjs', "if (kind === 'server-suite' || /^apps\\/server\\/src\\/test-[^/]+\\.ts$/.test(testFile)) {", 'if (false) {'],
    ['the lockfile and the package config touch every test of the package', 'lib.mjs', "f === 'pnpm-lock.yaml'", "f === 'no-such-lockfile'"],
    ['gh is only ever read', 'record.mjs', 'if (!reads[a]?.includes(b)) throw', 'if (false) throw'],
    ['the ledger: once per job, SECOND-HIT only on another PR within 14 days', 'record.mjs', 'if (have.has(recordKey(entry))) {', 'if (false) {'],
    ['the ledger: once per job, SECOND-HIT only on another PR within 14 days', 'lib.mjs', 'String(e.pr) !== String(entry.pr) && near(e)', 'near(e)'],
    ['the ledger: once per job, SECOND-HIT only on another PR within 14 days', 'lib.mjs', 'Math.abs(Date.parse(e.time) - t) <= days * 86400e3', 'true'],
    ['stress cross-check: SEEN-ON-CI only for the same test', 'record.mjs', 'const same = namesATest(e) && names.some(', 'const same = true || names.some('],
    ['stress cross-check: SEEN-ON-CI only for the same test', 'record.mjs', 'const same = namesATest(e) && names.some(', 'const same = names.some('],
    ['gh api: a write flag with its value attached is refused too', 'record.mjs', "/^-[^-]/.test(x) && /[XfF]/.test(x) || /^--(method|field|raw-field|input)(=|$)/.test(x)",
        '/^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/.test(x)'],
    ['gh api: a write flag with its value attached is refused too', 'record.mjs', "/^-[^-]/.test(x) && /[XfF]/.test(x) || ", '/^-[XfF]$/.test(x) || '],
    ['only the same named test pairs; a failed check that names no test pairs with nothing', 'lib.mjs', "export const namesATest = (e) => e.kind !== 'check';", 'export const namesATest = () => true;'],
    ['only the same named test pairs; a failed check that names no test pairs with nothing', 'lib.mjs', 'const others = ledger.filter((e) => namesATest(e) && ', 'const others = ledger.filter((e) => '],
    ['only the same named test pairs; a failed check that names no test pairs with nothing', 'lib.mjs', 'if (!namesATest(entry)) return { same: [], sameFile: [] };', ''],
    ['two PRs\' own check reds are recorded as "check red, no test named", never SECOND-HIT', 'lib.mjs', "export const namesATest = (e) => e.kind !== 'check';", 'export const namesATest = () => true;'],
    ['two PRs\' own check reds are recorded as "check red, no test named", never SECOND-HIT', 'record.mjs', "(namesATest(entry) ? '' : '; never counted toward a second hit')", "''"],
    ['node --test on CI: each failed test with its file, never the describe around it', 'lib.mjs', `if (yaml.includes("failureType: 'subtestsFailed'")) continue;`, ''],
    ['node --test on CI: each failed test with its file, never the describe around it', 'lib.mjs', "add({ test: m[1], kind: 'node-test', check: section.check, file: loc, pkg: null });", "add({ test: m[1], kind: 'node-test', check: section.check, file: null, pkg: null });"],
    ['node v26 spec output is read, so SEEN-ON-CI fires for a node --test file', 'lib.mjs', "(m = /^✖ (.+?)(?: \\(\\d+(?:\\.\\d+)?m?s\\))?$/.exec(t))", 'false'],
    ['node v26 spec output is read, so SEEN-ON-CI fires for a node --test file', 'lib.mjs', '/^✖ (.+?)(?: \\(\\d+(?:\\.\\d+)?m?s\\))?$/', '/^✖ (.+?)$/'],
    ['node v26 spec output is read, so SEEN-ON-CI fires for a node --test file', 'lib.mjs', "(!specList || /^test at /.test(L[i - 1] ?? '')) && ", ''],
    ['node v26 spec output is read, so SEEN-ON-CI fires for a node --test file', 'lib.mjs', "/^test at /.test(L[i - 1] ?? '')", 'true'],
];

for (const [name, check] of Object.entries(RULES)) {
    test(name, async () => { await check(await load(HERE), HERE); });
}
for (const [rule, file, from, to] of MUTANTS) {
    test(`mutant goes red: ${rule} (${file}: ${from.slice(0, 48)})`, async () => {
        const dir = mutate(file, from, to);
        // Red by one of the rule's own assertions, not by a crash (a missing file would "go red" while proving nothing).
        await assert.rejects(async () => RULES[rule](await load(dir), dir), (err) => err?.code === 'ERR_ASSERTION',
            `the check passed (or crashed) against a copy with "${from}" broken`);
    });
}
test('every rule has a mutant', () => {
    assert.deepEqual([...new Set(MUTANTS.map((m) => m[0]))].sort(), Object.keys(RULES).sort());
});

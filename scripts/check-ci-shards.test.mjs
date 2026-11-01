// CI runs test-all.sh's checks split across the jobs of one matrix (.github/workflows/ci.yml, Fable test-throughput S3):
// each shard runs the checks it names in TEST_ALL_ONLY. These tests fail when a check is in no shard (it would never
// run on CI) or in two, when the vitest slices or the server-suite shards leave a part out, and when the required
// check's name is not on exactly one job, the aggregate the "Protect main" ruleset matches by name.
// Run by test-all.sh (the `workflows` check): node --test scripts/check-workflows.test.mjs scripts/check-ci-shards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SUITES, VARIANTS, SERIAL } from './server-suites.mjs';
import { readSnapshot, splitIntoShards, parseShard } from './server-suite-shards.mjs';
import { baselineBase } from './words/words.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(ROOT, '.github/workflows');
const CI = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');
const TEST_ALL = readFileSync(join(ROOT, 'scripts/test-all.sh'), 'utf8');

// The "Protect main" ruleset's required status check (GitHub: Settings → Rules; integration 15368, GitHub Actions).
export const REQUIRED_CHECK = 'Run BeanPool Test-All Pipeline';

/** test-all.sh's checks: the name on every `run_check "<name>"` and `skip_check "<name>"` line. */
const checkNames = (text) => [...new Set([...text.matchAll(/^ *(?:run|skip)_check "([a-z0-9_]+)"/gm)].map((m) => m[1]))];

/** check -> the check it waits for (`wait_for_check <dep>` inside the function its run_check line runs). */
function waits(text) {
    const out = {};
    for (const [, fn, body] of text.matchAll(/^(\w+)\(\) \{\n((?:.*\n)*?)\}$/gm)) {
        const dep = /wait_for_check (\w+)/.exec(body)?.[1];
        const name = dep && new RegExp(`^run_check "([a-z0-9_]+)" +${fn}\\s*$`, 'm').exec(text)?.[1];
        if (name) out[name] = dep;
    }
    return out;
}

/** The text of one job: its `  <id>:` line and every line under it. */
const jobText = (text, id) => new RegExp(`^ {2}${id}:\\n(?:(?: {4}.*)?\\n)*`, 'm').exec(text)?.[0] ?? '';

/** The shard job's matrix: [{ name, checks: [...], test_slice, server_shard, ... }], one `- { ... }` line each. */
function shardsOf(ciText) {
    return [...jobText(ciText, 'shard').matchAll(/^ {10}- \{(.*)\}\s*$/gm)].map(([, body]) => {
        const entry = {};
        for (const [, key, quoted, bare] of body.matchAll(/(\w+):\s*(?:"([^"]*)"|([^,]+?))\s*(?:,|$)/g)) entry[key] = quoted ?? bare;
        entry.checks = (entry.checks || '').split(/\s+/).filter(Boolean);
        return entry;
    });
}

/** Every way the shards fail to run each check exactly once; [] when they do. */
export function shardProblems(ciText, testAllText) {
    const problems = [];
    const names = checkNames(testAllText);
    const shards = shardsOf(ciText);
    if (shards.length === 0) return ['ci.yml: no shard matrix (jobs.shard.strategy.matrix.include, one `- { ... }` line each)'];
    const seen = new Set();
    for (const s of shards) {
        if (!s.name) problems.push(`a shard has no name: ${JSON.stringify(s)}`);
        if (seen.has(s.name)) problems.push(`shard ${s.name} is listed twice`);
        seen.add(s.name);
        if (s.checks.length === 0) problems.push(`shard ${s.name} names no check (an empty TEST_ALL_ONLY runs every check)`);
        for (const c of s.checks) if (!names.includes(c)) problems.push(`shard ${s.name} names ${c}, which is no check in test-all.sh`);
    }
    // Two checks are split across shards, each part named by its key; checked part by part below.
    const SPLIT_BY = { test: 'test_slice', server_suites: 'server_shard' };
    for (const name of names) {
        const inShards = shards.filter((s) => s.checks.includes(name));
        if (inShards.length === 0) problems.push(`${name} is in no shard: CI would never run it`);
        else if (inShards.length > 1) {
            const whole = inShards.filter((s) => !SPLIT_BY[name] || !s[SPLIT_BY[name]]);
            if (whole.length) problems.push(`${name} is in ${inShards.length} shards (${inShards.map((s) => s.name).join(', ')}): it would run twice`);
        }
    }
    // The vitest slices: `--filter=<pkg> -- --shard=i/n` for each of n, and ONE remainder that excludes exactly those packages.
    const sliced = shards.filter((s) => s.test_slice);
    for (const s of sliced) if (s.checks.join(' ') !== 'test') problems.push(`shard ${s.name} has a test_slice but runs ${s.checks.join(' ')}: a slice is the test check alone`);
    const parts = {};
    const rests = [];
    for (const s of sliced) {
        const pos = [...s.test_slice.matchAll(/--filter=([^!\s]\S*)/g)].map((m) => m[1]);
        const neg = [...s.test_slice.matchAll(/--filter=!(\S+)/g)].map((m) => m[1]);
        const vs = /-- --shard=(\d+)\/(\d+)$/.exec(s.test_slice);
        // turbo 2.8 hands arguments after `--` to every task in the run, the dependencies' builds too (`tsc --shard=1/2`
        // fails): --only runs the test task alone, after test-all.sh has built core, engine and signin.
        if (/(^|\s)--(\s|$)/.test(s.test_slice) && !/(^|\s)--only(\s|$)/.test(s.test_slice)) problems.push(`shard ${s.name}: test_slice passes arguments after -- without --only, so turbo hands them to the builds too`);
        if (pos.length === 1 && neg.length === 0 && vs) (parts[pos[0]] ||= []).push(`${vs[1]}/${vs[2]}`);
        else if (pos.length === 0 && neg.length > 0 && !vs) rests.push(neg);
        else problems.push(`shard ${s.name}: test_slice "${s.test_slice}" is neither --filter=<pkg> -- --shard=i/n nor only --filter=!<pkg>`);
    }
    if (sliced.length) {
        if (rests.length !== 1) problems.push(`the test check needs exactly one remainder shard (only --filter=!<pkg>), found ${rests.length}`);
        const excluded = (rests[0] || []).slice().sort().join(' ');
        const split = Object.keys(parts).sort().join(' ');
        if (excluded !== split) problems.push(`the remainder excludes [${excluded}] but the packages split by vitest --shard are [${split}]: a package would run twice or never`);
        for (const [pkg, got] of Object.entries(parts)) {
            const n = Number(got[0].split('/')[1]);
            const want = Array.from({ length: n }, (_, i) => `${i + 1}/${n}`).join(' ');
            // By shard number, not as strings: "10/10" sorts before "2/10".
            if (got.slice().sort((a, b) => parseInt(a) - parseInt(b)).join(' ') !== want) problems.push(`${pkg}'s vitest shards are ${got.join(' ')}, not ${want}`);
        }
    }
    // The server-suite shards: server_shard i/K on each shard that runs server_suites, and only there, 1/K to K/K.
    const server = shards.filter((s) => s.checks.includes('server_suites') || s.server_shard);
    if (server.length > 1 || server.some((s) => s.server_shard)) {
        const specs = server.map((s) => ({ s, spec: parseShard(s.server_shard) }));
        for (const { s, spec } of specs) {
            if (!spec) problems.push(`shard ${s.name}: server_shard "${s.server_shard ?? ''}" is not i/K`);
            if (s.checks.join(' ') !== 'server_suites') problems.push(`shard ${s.name} has a server_shard but runs ${s.checks.join(' ')}`);
        }
        const k = specs[0]?.spec?.count;
        const got = specs.map(({ spec }) => (spec ? `${spec.index}/${spec.count}` : '?')).sort().join(' ');
        const want = Array.from({ length: k || 0 }, (_, i) => `${i + 1}/${k}`).sort().join(' ');
        if (!k || got !== want) problems.push(`the server shards are ${got}, not 1/K to K/K (K = the number of server shards in the matrix)`);
    }
    // A check that waits for another (website_status for website_contrast's Chromium) is in the same shard as it.
    for (const [name, dep] of Object.entries(waits(testAllText))) {
        const a = shards.find((s) => s.checks.includes(name))?.name;
        const b = shards.find((s) => s.checks.includes(dep))?.name;
        if (a && b && a !== b) problems.push(`${name} waits for ${dep} but runs in ${a}, not ${b}`);
    }
    return problems;
}

/** Every way the required check's name is wrong: not on the aggregate job, on another job, or the aggregate not gating every shard. */
export function requiredCheckProblems(ciText, otherWorkflowTexts = []) {
    const problems = [];
    const job = jobText(ciText, 'test-all');
    if (!new RegExp(`^ {4}name: ${REQUIRED_CHECK}\\s*$`, 'm').test(job)) problems.push(`jobs.test-all is not named "${REQUIRED_CHECK}", the ruleset's required check`);
    if (!/^ {4}needs: \[?\s*shard\s*\]?\s*$/m.test(job)) problems.push('jobs.test-all does not need the shard job');
    if (!/^ {4}if: always\(\)\s*$/m.test(job)) problems.push('jobs.test-all has no `if: always()`: with a red shard it would be skipped, and a skipped required check passes');
    if (!/\[ "\$SHARDS" = success \]/.test(job)) problems.push('jobs.test-all does not fail unless every shard succeeded');
    const named = [ciText, ...otherWorkflowTexts].flatMap((t) => [...t.matchAll(/^ +name: (.*)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, '')))
        .filter((n) => n === REQUIRED_CHECK);
    if (named.length !== 1) problems.push(`${named.length} jobs or steps are named "${REQUIRED_CHECK}": exactly one, the aggregate, may be`);
    return problems;
}

const otherWorkflows = () => readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f) && f !== 'ci.yml').map((f) => readFileSync(join(WORKFLOWS, f), 'utf8'));

/** The checks that compare with main, by name. The guide's is inside the `test` check: see reachesGuide. */
const COMPARES_WITH_MAIN = ['migration_steps', 'words'];
/** Whether a vitest slice runs @beanpool/guide's test task (scripts/build.mjs --check): named, or a remainder not excluding it. */
const reachesGuide = (slice = '') => slice.includes('--filter=@beanpool/guide') || (slice !== '' && !/--filter=[^!]/.test(slice) && !slice.includes('--filter=!@beanpool/guide'));

/** The text of one step of the shard job: its `- name:` line and the lines under it. */
const stepText = (ciText, name) => new RegExp(`^ {6}- name: ${name}\\n(?:(?: {8}.*)?\\n)*`, 'm').exec(ciText)?.[0] ?? '';
/** The shell in a step's `run: |` block. */
const stepScript = (step) => (/^ {8}run: \|\n((?: {10}.*\n)+)/m.exec(step)?.[1] ?? '').replace(/^ {10}/gm, '');

/**
 * Every way the shards that compare with main can lose origin/main: they would pass having compared nothing (on GitHub
 * migration_steps was a pass in 0 s on every pull request). And, the fetch costing seconds, any shard that has it for nothing.
 */
export function compareMainProblems(ciText) {
    const problems = [];
    for (const s of shardsOf(ciText)) {
        const why = s.checks.filter((c) => COMPARES_WITH_MAIN.includes(c)).concat(reachesGuide(s.test_slice) ? ['the guide check'] : []);
        if (why.length && s.compare_main !== 'true') problems.push(`shard ${s.name} runs ${why.join(' and ')}, which compare${why.length > 1 ? '' : 's'} with main, but has no compare_main: true`);
        if (!why.length && s.compare_main) problems.push(`shard ${s.name} has compare_main but runs nothing that compares with main: a fetch for nothing`);
    }
    const step = stepText(ciText, 'Fetch origin/main');
    if (!step) return [...problems, 'ci.yml has no step "Fetch origin/main": on a pull request or a branch there is no origin/main to compare with'];
    if (!/^ {8}if: matrix\.compare_main\b/m.test(step)) problems.push('the step "Fetch origin/main" is not conditional on matrix.compare_main');
    const script = stepScript(step);
    if (!script.includes('+refs/heads/main:refs/remotes/origin/main')) problems.push('the step "Fetch origin/main" does not write refs/remotes/origin/main');
    if (!/fetch\b.*--depth=\d+/.test(script)) problems.push('the step "Fetch origin/main" does not fetch a depth: a merge base needs history on both sides');
    if (ciText.indexOf('- name: Fetch origin/main') > ciText.indexOf('- name: Run test-all checks')) problems.push('the step "Fetch origin/main" comes after the checks');
    return problems;
}

/** A workflow's triggers: { <event>: [its lines] }, read as lines like the rest of this file. */
function triggersOf(text) {
    const block = /^on:\s*\n((?:(?: +.*|\s*)\n)*)/m.exec(text)?.[1] ?? '';
    const out = {};
    let event = null;
    for (const line of block.split('\n')) {
        if (/^\s*(#.*)?$/.test(line)) continue;
        const key = /^ {2}(\w+):/.exec(line);
        if (key) (out[(event = key[1])] = []).push(line);
        else if (event) out[event].push(line);
    }
    return out;
}

/**
 * What a train's shadow (scripts/test-all-train.sh --shadow) rests on. ci.yml runs the whole matrix on a dispatch of any
 * branch and can deploy nothing, and no workflow starts on the push of a train/* branch by itself.
 */
export function trainBranchProblems(ciText, otherWorkflowTexts = []) {
    const problems = [];
    const dispatch = triggersOf(ciText).workflow_dispatch;
    if (!dispatch) problems.push('ci.yml has no workflow_dispatch: a train branch could not be started');
    else if (dispatch.length > 1) problems.push('ci.yml\'s workflow_dispatch takes inputs: a train\'s dispatch passes none');
    const shard = jobText(ciText, 'shard');
    if (/^ {4}if:/m.test(shard)) problems.push('jobs.shard has an `if:`: the whole matrix must run on a dispatch of a train branch');
    if (/^\s*environment:/m.test(ciText)) problems.push('ci.yml names an environment: a dispatch of a train branch must reach no deploy');
    if (/\bsecrets\./.test(ciText)) problems.push('ci.yml reads a secret: a dispatch of a train branch must reach no deploy');
    if (!/^permissions:\n {2}contents: read\s*$/m.test(ciText)) problems.push('ci.yml\'s token is not read-only');
    for (const text of [ciText, ...otherWorkflowTexts]) {
        const name = /^name: (.*)$/m.exec(text)?.[1] ?? 'a workflow';
        const on = triggersOf(text);
        for (const event of Object.keys(on)) {
            if (!['workflow_dispatch', 'push', 'pull_request'].includes(event)) problems.push(`${name} starts on ${event}, which a push of a train/* branch may fire: check it and add it here`);
        }
        if (on.push) {
            const branches = on.push.find((l) => /^ {4}branches:/.test(l));
            const tags = on.push.some((l) => /^ {4}tags:/.test(l));
            if (branches ? !/^ {4}branches: \[main\]\s*$/.test(branches) : !tags) problems.push(`${name}: push is not limited to main, so a train/* branch would start it`);
        }
    }
    return problems;
}

test('every test-all check runs in exactly one CI shard', () => {
    assert.ok(checkNames(TEST_ALL).length >= 30, `found ${checkNames(TEST_ALL).length} checks in test-all.sh`);
    assert.ok(shardsOf(CI).length >= 10, `found ${shardsOf(CI).length} shards in ci.yml`);
    assert.deepEqual(shardProblems(CI, TEST_ALL), []);
});

test('a package split into ten vitest shards or more passes, and one of them missing fails', () => {
    const pwa = (n) => Array.from({ length: n }, (_, i) => `          - { name: vitest-pwa-${i + 1}, checks: test, test_slice: "--only --filter=@beanpool/pwa -- --shard=${i + 1}/${n}" }\n`).join('');
    const ten = CI.replace(/^ {10}- \{ name: vitest-pwa-1,.*\n {10}- \{ name: vitest-pwa-2,.*\n/m, pwa(10));
    assert.notEqual(ten, CI);
    assert.deepEqual(shardProblems(ten, TEST_ALL), []);
    const nine = ten.replace(/^ {10}- \{ name: vitest-pwa-10,.*\n/m, '');
    assert.notEqual(nine, ten);
    assert.match(shardProblems(nine, TEST_ALL).join('\n'), /@beanpool\/pwa's vitest shards are 1\/10 .* 9\/10, not 1\/10 2\/10 .* 10\/10/);
});

test('the aggregate job carries the required check name, alone, and fails unless every shard passed', () => {
    assert.deepEqual(requiredCheckProblems(CI, otherWorkflows()), []);
});

test('the server shards split every run exactly once, the same way each time', () => {
    const runs = [...SUITES.map((e) => ({ id: typeof e === 'string' ? e : e.name })), ...VARIANTS.map((v) => ({ id: v.tag ? `${v.name}(${v.tag})` : v.name }))];
    const k = shardsOf(CI).filter((s) => s.server_shard).length;
    assert.ok(k >= 2, `${k} server shards`);
    const split = () => splitIntoShards(runs, { durations: readSnapshot(), serial: SERIAL, count: k }).map((s) => s.runs.map((r) => r.id));
    const once = split();
    const all = once.flat();
    assert.equal(all.length, runs.length);
    assert.deepEqual([...all].sort(), runs.map((r) => r.id).sort());
    assert.deepEqual(split(), once, 'the same split on every call');
    assert.deepEqual(splitIntoShards([...runs].reverse(), { durations: readSnapshot(), serial: SERIAL, count: k }).map((s) => s.runs.map((r) => r.id).sort()),
        once.map((ids) => [...ids].sort()), 'the same shards whatever order the runs come in');
    for (const ids of once) assert.ok(ids.length > 0, 'no shard is empty');
    // A suite the snapshot does not know goes first, so new suites spread one to a shard. Every real run is given a time
    // here, so the k made-up suites are the only unknown ones: suites added since the snapshot was last refreshed (main
    // adds them most days) would otherwise also go first and take a shard's first place.
    const fresh = Array.from({ length: k }, (_, i) => ({ id: `test-zz-new-${i}` }));
    const known = { ...readSnapshot() };
    for (const r of runs) known[r.id] ??= 1;
    const withNew = splitIntoShards([...runs, ...fresh], { durations: known, serial: SERIAL, count: k });
    for (const s of withNew) assert.equal(s.runs.filter((r) => r.id.startsWith('test-zz-new-')).length, 1);
    assert.ok(withNew.every((s) => s.runs[0].id.startsWith('test-zz-new-')), 'unknown suites first');
});

test('the durations snapshot lists only runs the manifest has', () => {
    const ids = new Set([...SUITES.map((e) => (typeof e === 'string' ? e : e.name)), ...VARIANTS.map((v) => (v.tag ? `${v.name}(${v.tag})` : v.name))]);
    const stale = Object.keys(readSnapshot()).filter((id) => !ids.has(id));
    assert.ok(existsSync(join(ROOT, 'scripts/server-suite-durations.json')));
    assert.deepEqual(stale, [], 'refresh it with scripts/server-suite-durations-snapshot.mjs');
});

test('every shard that compares with main fetches it, and only those do', () => {
    assert.deepEqual(compareMainProblems(CI), []);
    assert.deepEqual(shardsOf(CI).filter((s) => s.compare_main).map((s) => s.name).sort(), ['checks', 'vitest-rest']);
});

test('the fetch of origin/main taken away, or a shard losing it, fails', () => {
    const noStep = CI.replace(stepText(CI, 'Fetch origin/main'), '');
    assert.notEqual(noStep, CI);
    assert.match(compareMainProblems(noStep).join('\n'), /no step "Fetch origin\/main"/);
    const without = (name) => CI.replace(new RegExp(`^( {10}- \\{ name: ${name},.*), compare_main: true \\}$`, 'm'), '$1 }');
    assert.notEqual(without('checks'), CI);
    assert.match(compareMainProblems(without('checks')).join('\n'), /shard checks runs migration_steps and words, which compare with main, but has no compare_main/);
    assert.match(compareMainProblems(without('vitest-rest')).join('\n'), /shard vitest-rest runs the guide check/);
    assert.match(compareMainProblems(CI.replace('if: matrix.compare_main', 'if: false')).join('\n'), /not conditional on matrix\.compare_main/);
    assert.match(compareMainProblems(CI.replace('main=+refs/heads/main:refs/remotes/origin/main', 'main=+refs/heads/main:refs/remotes/origin/x')).join('\n'), /does not write refs\/remotes\/origin\/main/);
    assert.match(compareMainProblems(CI.replace('--depth=50 ', '')).join('\n'), /does not fetch a depth/);
    // A check moved into a shard with no fetch.
    const moved = CI.replace(' migration_steps ', ' ').replace('name: settings-phone-1, checks: settings_phone_width', 'name: settings-phone-1, checks: "settings_phone_width migration_steps"');
    assert.match(compareMainProblems(moved).join('\n'), /shard settings-phone-1 runs migration_steps/);
    // A shard that compares with nothing, paying for the fetch.
    const idle = CI.replace(/^( {10}- \{ name: server-1,.*) \}$/m, '$1, compare_main: true }');
    assert.match(compareMainProblems(idle).join('\n'), /shard server-1 has compare_main but runs nothing/);
});

test('a dispatch of a train branch runs the whole matrix and reaches no deploy, and a train branch starts no workflow by itself', () => {
    assert.deepEqual(trainBranchProblems(CI, otherWorkflows()), []);
    assert.match(trainBranchProblems(CI.replace('  workflow_dispatch:\n', '')).join('\n'), /no workflow_dispatch/);
    assert.match(trainBranchProblems(CI.replace('  workflow_dispatch:\n', '  workflow_dispatch:\n    inputs:\n      x:\n        type: string\n')).join('\n'), /takes inputs/);
    assert.match(trainBranchProblems(CI.replace("    name: Test-All shard ${{ matrix.name }}\n", "    name: Test-All shard ${{ matrix.name }}\n    if: github.event_name != 'workflow_dispatch'\n")).join('\n'), /jobs\.shard has an `if:`/);
    assert.match(trainBranchProblems(CI.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    environment: production\n')).join('\n'), /names an environment/);
    assert.match(trainBranchProblems(`${CI}\n# ${'$'}{{ secrets.DEPLOY_TOKEN }}\n`).join('\n'), /reads a secret/);
    assert.match(trainBranchProblems(CI.replace('  contents: read\n', '  contents: write\n')).join('\n'), /token is not read-only/);
    const other = (on) => `name: x\non:\n${on}\npermissions: {}\n`;
    assert.match(trainBranchProblems(CI, [other('  push:\n    branches: ["**"]')]).join('\n'), /x: push is not limited to main/);
    assert.match(trainBranchProblems(CI, [other('  push:')]).join('\n'), /x: push is not limited to main/);
    assert.match(trainBranchProblems(CI, [other('  create:')]).join('\n'), /x starts on create/);
    assert.deepEqual(trainBranchProblems(CI, [other("  push:\n    tags: ['v[0-9]*']")]), [], 'tags alone: no branch starts it');
});

test('the fetch step, run on a pull request\'s merge commit and on a train branch, gives the checks a merge base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-fetch-'));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };
    const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
        const src = join(dir, 'src');
        mkdirSync(join(src, 'scripts'), { recursive: true });
        mkdirSync(join(src, 'apps/registrar/migrations'), { recursive: true });
        git(src, 'init', '-q', '-b', 'main');
        git(src, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
        copyFileSync(join(ROOT, 'scripts/check-migrations-unchanged.sh'), join(src, 'scripts/check-migrations-unchanged.sh'));
        const MIGRATION = 'apps/registrar/migrations/0001.sql';
        const commit = (msg, file, text) => {
            if (file) { writeFileSync(join(src, file), text); git(src, 'add', file); }
            git(src, 'commit', '-q', '--allow-empty', '-m', msg);
            return git(src, 'rev-parse', 'HEAD');
        };
        git(src, 'add', 'scripts');
        commit('shipped', MIGRATION, 'create table a;\n');
        const pr = (branch, file, text) => { git(src, 'checkout', '-q', '-b', branch, 'main'); commit(branch, file, text); git(src, 'checkout', '-q', 'main'); };
        pr('edits', MIGRATION, 'create table a; -- edited\n');
        for (const n of [2, 3, 4, 5]) pr(`adds-${n}`, `apps/registrar/migrations/000${n}.sql`, `create table t${n};\n`);
        const mainAtMerge = commit('main moves on');
        const merged = (name, ...branches) => {
            git(src, 'checkout', '-q', '-b', name, 'main');
            for (const b of branches) git(src, 'merge', '-q', '--no-ff', '-m', `merge ${b}`, b);
            const tip = git(src, 'rev-parse', 'HEAD');
            git(src, 'checkout', '-q', 'main');
            return tip;
        };
        const prMerge = merged('pull-merge', 'edits');                                      // refs/pull/N/merge: main's tip first
        const train = merged('train/bad', 'edits', 'adds-2', 'adds-3', 'adds-4');           // four merges: main is four back
        const cleanTrain = merged('train/clean', 'adds-2', 'adds-3', 'adds-4', 'adds-5');
        commit('main moves on while the run waits');

        // What actions/checkout leaves with fetch-depth 2: no origin/main, on a pull request or a branch.
        const checkout = (name, sha, ref) => {
            const c = join(dir, name);
            mkdirSync(c);
            git(c, 'init', '-q');
            git(c, 'remote', 'add', 'origin', `file://${src}`);
            git(c, 'fetch', '-q', '--no-tags', '--depth=2', 'origin', `+${sha}:${ref}`);
            git(c, 'checkout', '-q', '--detach', sha);
            return c;
        };
        const migrations = (c) => spawnSync('bash', ['scripts/check-migrations-unchanged.sh'], { cwd: c, env, encoding: 'utf8' });
        const script = stepScript(stepText(CI, 'Fetch origin/main'));
        const fetchStep = (c) => {
            const r = spawnSync('bash', ['-e', '-c', script], { cwd: c, env, encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
        };
        const proves = (name, sha, ref, want) => {
            const c = checkout(name, sha, ref);
            const before = migrations(c);
            assert.equal(before.status, 0, `${name}: with no fetch it passes`);
            assert.match(before.stdout, /⚪ SKIP: no origin\/main here/, `${name}: having compared nothing`);
            fetchStep(c);
            const after = migrations(c);
            assert.equal(after.status, want.status, `${name}: ${after.stdout}`);
            assert.match(after.stdout, want.says, name);
            assert.doesNotMatch(after.stdout, /SKIP/, name);
            return c;
        };
        const FAILS = { status: 1, says: /Shipped migration step\(s\) changed[^]*0001\.sql/ };
        const PR_EVENT = { GITHUB_EVENT_NAME: 'pull_request' };
        const onPr = proves('pr', prMerge, 'refs/remotes/pull/7/merge', FAILS);
        assert.equal(baselineBase({ cwd: onPr, env: PR_EVENT }).ref, mainAtMerge, 'the words baseline: main when the merge was made');
        const onTrain = proves('train', train, 'refs/remotes/origin/train/bad', FAILS);
        const DISPATCH = { GITHUB_EVENT_NAME: 'workflow_dispatch' };
        assert.equal(baselineBase({ cwd: onTrain, env: DISPATCH }).ref, mainAtMerge, 'the words baseline, on a train: main under the first merge');
        assert.equal(baselineBase({ cwd: checkout('no-fetch', train, 'refs/remotes/origin/train/bad'), env: DISPATCH }).ref, null, 'with no fetch it compares nothing');
        proves('clean', cleanTrain, 'refs/remotes/origin/train/clean', { status: 0, says: /✓ no shipped migration step changed/ });

        // A re-run days later: main has moved past the depth, so the step goes on to the whole history.
        for (let i = 0; i < 60; i++) commit(`main ${i}`);
        proves('stale', prMerge, 'refs/remotes/pull/7/merge', FAILS);

        // A push to main: checkout writes origin/main at HEAD, so main is compared with main before the push.
        const onMain = checkout('main-push', git(src, 'rev-parse', 'main'), 'refs/remotes/origin/main');
        assert.match(migrations(onMain).stdout, /✓ no shipped migration step changed/);
        const landed = commit('a shipped step edited on main', MIGRATION, 'create table a; -- edited on main\n');
        const pushed = checkout('main-edit', landed, 'refs/remotes/origin/main');
        assert.equal(migrations(pushed).status, 1, 'an edit that reached main is red on the push');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('each edit the check exists to catch fails it', () => {
    const shardLine = (name) => new RegExp(`^ {10}- \\{ name: ${name},.*\\n`, 'm');
    // A check taken out of its shard.
    const dropped = CI.replace(/(name: checks, checks: "[^"]*) secrets_guard"/, '$1"');
    assert.notEqual(dropped, CI);
    assert.match(shardProblems(dropped, TEST_ALL).join('\n'), /secrets_guard is in no shard/);
    // A check in two shards.
    const twice = CI.replace(/(name: settings-phone-1, checks: )settings_phone_width/, '$1"settings_phone_width lint"');
    assert.notEqual(twice, CI);
    assert.match(shardProblems(twice, TEST_ALL).join('\n'), /lint is in 2 shards/);
    // A split check also named whole in another shard.
    assert.match(shardProblems(CI.replace('name: checks, checks: "build ', 'name: checks, checks: "build test '), TEST_ALL).join('\n'), /test is in 6 shards .*it would run twice/);
    assert.match(shardProblems(CI.replace('name: checks, checks: "build ', 'name: checks, checks: "build server_suites '), TEST_ALL).join('\n'), /server_suites is in 8 shards/);
    // A new check in test-all.sh that no shard names.
    assert.match(shardProblems(CI, `${TEST_ALL}\nrun_check "brand_new" true\n`).join('\n'), /brand_new is in no shard/);
    // ... and one with a digit in its name (a [a-z_]+ pattern would never see it, so no shard would be asked for it).
    assert.match(shardProblems(CI, `${TEST_ALL}\nrun_check "pwa_e2e2" true\n`).join('\n'), /pwa_e2e2 is in no shard/);
    // A misspelt name in a shard.
    assert.match(shardProblems(CI.replace('website_lang"', 'website_langs"'), TEST_ALL).join('\n'), /website_langs, which is no check/);
    // A server shard removed: the others no longer count to K.
    const fewer = CI.replace(shardLine('server-6'), '');
    assert.notEqual(fewer, CI);
    assert.match(shardProblems(fewer, TEST_ALL).join('\n'), /server shards are .* not 1\/K to K\/K/);
    // A vitest half removed, or the remainder no longer excluding a split package.
    const half = CI.replace(shardLine('vitest-pwa-2'), '');
    assert.notEqual(half, CI);
    assert.match(shardProblems(half, TEST_ALL).join('\n'), /@beanpool\/pwa's vitest shards are 1\/2, not 1\/2 2\/2/);
    assert.match(shardProblems(CI.replace(' --filter=!@beanpool/pwa"', '"'), TEST_ALL).join('\n'), /a package would run twice or never/);
    assert.match(shardProblems(CI.replace('"--only --filter=@beanpool/pwa -- --shard=2/2"', '"--filter=@beanpool/pwa -- --shard=2/2"'), TEST_ALL).join('\n'), /vitest-pwa-2: test_slice passes arguments after -- without --only/);
    // A waiting check moved away from the check it waits for.
    const moved = CI.replace(' website_status ', ' ').replace(/(name: checks, checks: ")/, '$1website_status ');
    assert.notEqual(moved, CI);
    assert.match(shardProblems(moved, TEST_ALL).join('\n'), /website_status waits for website_contrast/);
    // The aggregate renamed, a second job given the name, or the aggregate no longer always()/gating.
    assert.match(requiredCheckProblems(CI.replace(`    name: ${REQUIRED_CHECK}\n`, '    name: Test-All\n')).join('\n'), /jobs.test-all is not named/);
    assert.match(requiredCheckProblems(CI.replace('Test-All shard ${{ matrix.name }}', REQUIRED_CHECK)).join('\n'), /2 jobs or steps are named/);
    assert.match(requiredCheckProblems(CI, [`jobs:\n  x:\n    name: ${REQUIRED_CHECK}\n`]).join('\n'), /2 jobs or steps are named/);
    assert.match(requiredCheckProblems(CI.replace('    if: always()\n', '')).join('\n'), /no `if: always\(\)`/);
    assert.match(requiredCheckProblems(CI.replace('    needs: shard\n', '')).join('\n'), /does not need the shard job/);
});

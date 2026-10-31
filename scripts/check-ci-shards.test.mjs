// CI runs test-all.sh's checks split across the jobs of one matrix (.github/workflows/ci.yml, Fable test-throughput S3):
// each shard runs the checks it names in TEST_ALL_ONLY. These tests fail when a check is in no shard (it would never
// run on CI) or in two, when the vitest slices or the server-suite shards leave a part out, and when the required
// check's name is not on exactly one job, the aggregate the "Protect main" ruleset matches by name.
// Run by test-all.sh (the `workflows` check): node --test scripts/check-workflows.test.mjs scripts/check-ci-shards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITES, VARIANTS, SERIAL } from './server-suites.mjs';
import { readSnapshot, splitIntoShards, parseShard } from './server-suite-shards.mjs';

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
    // A suite the snapshot does not know goes first, so new suites spread one to a shard.
    const fresh = Array.from({ length: k }, (_, i) => ({ id: `test-zz-new-${i}` }));
    const withNew = splitIntoShards([...runs, ...fresh], { durations: readSnapshot(), serial: SERIAL, count: k });
    for (const s of withNew) assert.equal(s.runs.filter((r) => r.id.startsWith('test-zz-new-')).length, 1);
    assert.ok(withNew.every((s) => s.runs[0].id.startsWith('test-zz-new-')), 'unknown suites first');
});

test('the durations snapshot lists only runs the manifest has', () => {
    const ids = new Set([...SUITES.map((e) => (typeof e === 'string' ? e : e.name)), ...VARIANTS.map((v) => (v.tag ? `${v.name}(${v.tag})` : v.name))]);
    const stale = Object.keys(readSnapshot()).filter((id) => !ids.has(id));
    assert.ok(existsSync(join(ROOT, 'scripts/server-suite-durations.json')));
    assert.deepEqual(stale, [], 'refresh it with scripts/server-suite-durations-snapshot.mjs');
});

test('each edit the check exists to catch fails it', () => {
    const shardLine = (name) => new RegExp(`^ {10}- \\{ name: ${name},.*\\n`, 'm');
    // A check taken out of its shard.
    const dropped = CI.replace(/(name: checks, checks: "[^"]*) secrets_guard"/, '$1"');
    assert.notEqual(dropped, CI);
    assert.match(shardProblems(dropped, TEST_ALL).join('\n'), /secrets_guard is in no shard/);
    // A check in two shards.
    const twice = CI.replace(/(name: settings-phone, checks: )settings_phone/, '$1"settings_phone lint"');
    assert.notEqual(twice, CI);
    assert.match(shardProblems(twice, TEST_ALL).join('\n'), /lint is in 2 shards/);
    // A split check also named whole in another shard.
    assert.match(shardProblems(CI.replace('name: checks, checks: "build ', 'name: checks, checks: "build test '), TEST_ALL).join('\n'), /test is in 6 shards .*it would run twice/);
    assert.match(shardProblems(CI.replace('name: checks, checks: "build ', 'name: checks, checks: "build server_suites '), TEST_ALL).join('\n'), /server_suites is in 7 shards/);
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
    assert.match(requiredCheckProblems(CI.replace('Test-All in one job (remove after 3 green main runs)', REQUIRED_CHECK)).join('\n'), /2 jobs or steps are named/);
    assert.match(requiredCheckProblems(CI, [`jobs:\n  x:\n    name: ${REQUIRED_CHECK}\n`]).join('\n'), /2 jobs or steps are named/);
    assert.match(requiredCheckProblems(CI.replace('    if: always()\n', '')).join('\n'), /no `if: always\(\)`/);
    assert.match(requiredCheckProblems(CI.replace('    needs: shard\n', '')).join('\n'), /does not need the shard job/);
});

// scripts/lanes/pr-state.mjs against recorded GitHub answers: no network, no real gh. Run by test-all.sh (the `workflows` check).
//
// fixtures/pr-state/ holds what GitHub really answered for #3169 (README there): its check runs on three heads (two reds with
// one the summary job; three reds; all green), five job logs from those heads and two from other PRs (a server suite, an
// esbuild error), its comments, commits and files. A stand-in gh serves them by the path asked and logs every call, so each
// run also proves the script only read. The mutants at the end change one rule in a copy of the script and show the test for
// that rule goes red, so no check here passes whatever the script does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRead, failureLines, isSummaryLog, namedFiles, namedHead, verdictOf } from '../pr-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');
const SCRIPT = join(HERE, '../pr-state.mjs');
const FIX = join(HERE, 'fixtures/pr-state');
const H = { two: '33a37470c694b654786ef73f3b44cfe90d1a8825', three: '5550edf63891119a775459aa0e47f51b5966bab5', green: 'a873832301fa6c0e8d77d8553f2b8c8f67be9818' };
const TMP = mkdtempSync(join(tmpdir(), 'pr-state-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
const json = (f) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
const log = (id) => readFileSync(join(FIX, 'logs', `${id}.txt`), 'utf8');

// The stand-in gh: answers `gh api <path>` from the scenario's files, 404 for anything it has no file for, and refuses every
// other command. Every call is logged, one JSON array per line.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = process.env.FAKE_GH_DIR, a = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(a) + '\n');
const send = (f) => { const p = path.join(dir, f); if (!fs.existsSync(p)) { console.error('HTTP 404: Not Found (' + f + ')'); process.exit(1); } fs.writeSync(1, fs.readFileSync(p)); process.exit(0); };
if (a[0] !== 'api') { console.error('stand-in gh: unexpected ' + a.join(' ')); process.exit(1); }
if (a[1] === 'graphql') send('pr.json');
const p = a.find((x) => x.startsWith('repos/')) || '';
let m;
if (/\/issues\/\d+\/comments/.test(p)) send('comments.json');
if (/\/pulls\/\d+\/reviews/.test(p)) send('reviews.json');
if (/\/pulls\/\d+\/commits/.test(p)) send('commits.json');
if (/\/pulls\/\d+\/files/.test(p)) send('files.json');
if ((m = /\/commits\/([0-9a-f]+)\/check-runs/.exec(p))) send('check-runs-' + m[1] + '.json');
if ((m = /\/commits\/([0-9a-f]+)\/status$/.exec(p))) send('status.json');
if ((m = /\/actions\/jobs\/(\d+)\/logs$/.exec(p))) send('logs/' + m[1] + '.txt');
console.error('stand-in gh: no route for ' + a.join(' ')); process.exit(1);
`;
const GH = join(TMP, 'gh');
writeFileSync(GH, FAKE_GH);
chmodSync(GH, 0o755);

const comments = () => json('comments-3169.json'); // [[NOT CLEAN of 5550edf6, CLEAN of 33a37470]]
const comment = (body, at, who = 'MEMBER') => ({ id: 1, html_url: 'https://example.invalid/c', created_at: at, author_association: who, user: { login: 'someone' }, body });
const runsOf = (head) => json(`check-runs-${head.slice(0, 8)}.json`);

let n = 0;
/**
 * A scenario directory: the PR at `head`, its comments, the check runs GitHub recorded for that head (optionally edited). The
 * PR is GitHub's recorded GraphQL answer for a queued PR (graphql-queued.json), set to #3169 out of the queue unless `pr` says.
 */
function scenario({ head, cs = comments(), runs = runsOf(head), logs = [], logAs = {}, pr: over = {} }) {
  const dir = join(TMP, `s${n++}`);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  const answer = json('graphql-queued.json');
  Object.assign(answer.data.repository.pullRequest, { number: 3169, title: 'Recorded #3169', headRefOid: head, headRefName: 'feat/example',
    mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', isInMergeQueue: false, mergeQueueEntry: null }, over);
  writeFileSync(join(dir, 'pr.json'), JSON.stringify(answer));
  writeFileSync(join(dir, 'comments.json'), JSON.stringify(cs));
  writeFileSync(join(dir, `check-runs-${head}.json`), JSON.stringify(runs));
  for (const f of ['reviews', 'commits', 'files']) cpSync(join(FIX, `${f}-3169.json`), join(dir, `${f}.json`));
  cpSync(join(FIX, 'status-none.json'), join(dir, 'status.json'));
  for (const id of logs) cpSync(join(FIX, 'logs', `${id}.txt`), join(dir, 'logs', `${id}.txt`));
  for (const [job, id] of Object.entries(logAs)) cpSync(join(FIX, 'logs', `${id}.txt`), join(dir, 'logs', `${job}.txt`)); // job answers with log id
  return dir;
}

/** Runs the script (or a mutated copy of it) on a scenario: {code, out, calls}. */
function run(dir, script = SCRIPT) {
  const env = { ...process.env, PR_STATE_GH: GH, FAKE_GH_DIR: dir, PR_STATE_ROOT: ROOT };
  delete env.LANE_CI_CHECK;
  delete env.LANE_GH_REPO;
  const r = spawnSync(process.execPath, [script, '3169', '-R', 'example/fake'], { env, encoding: 'utf8' });
  const callsFile = join(dir, 'calls.jsonl');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}

/** Independent of the script's own guard: a call is a read when it is `gh api` with no method, no input, and fields only on a GraphQL query. */
function onlyReads(calls) {
  for (const c of calls) {
    assert.equal(c[0], 'api', `not a read: gh ${c.join(' ')}`);
    assert.ok(!c.some((x) => /^(-X|--method|--input)/.test(x)), `not a read: gh ${c.join(' ')}`);
    const fields = c.filter((x, i) => /^(-f|-F|--field|--raw-field)$/.test(c[i - 1] ?? ''));
    if (fields.length) {
      assert.equal(c[1], 'graphql', `a field on a REST call is a POST: gh ${c.join(' ')}`);
      assert.match(fields.find((f) => f.startsWith('query=')) || '', /^query=query\b/, `not a query: gh ${c.join(' ')}`);
    }
  }
}

// ── the scenarios, each with what it must show ──────────────────────────────────────────────────────────────────────────

const SCENARIOS = {
  // #3169 at 33a37470: two reds, one of them the summary job. The verdict names this head.
  twoReds: {
    make: () => scenario({ head: H.two, logs: [132569745348, 132571592359] }),
    expect: ({ code, out }) => {
      assert.match(out, /^PR #3169 {2}feat\/example → main {2}OPEN {2}Recorded #3169$/m);
      assert.match(out, /^head {8}33a37470c694b654786ef73f3b44cfe90d1a8825$/m);
      assert.match(out, /^base {8}main$/m);
      assert.match(out, /^mergeable {3}MERGEABLE \(merge state BLOCKED\)$/m);
      assert.match(out, /^merge queue not in the queue$/m);
      assert.match(out, /names 33a37470 = the current head/);
      assert.match(out, /RED {5}Test-All shard checks — failure\n/);
      assert.match(out, /│ check no_google_fonts +❌ FAIL/);
      assert.match(out, /test file scripts\/no-google-fonts\.test\.mjs:57 {2}untouched by this PR/);
      assert.match(out, /test file apps\/pwa\/e2e\/forum-320\.mjs:268 {2}TOUCHED by this PR/);
      assert.match(out, /"untouched" is NOT proof of a flake/);
      assert.match(out, /RED {5}Run BeanPool Test-All Pipeline — failure {2}\[the SUMMARY check/);
      assert.match(out, /│ Shards: failure\n/);
      assert.ok(out.indexOf('Test-All shard checks —') < out.indexOf('Run BeanPool Test-All Pipeline —'), 'the cause is listed before the summary');
      assert.match(out, /gh run download 43632020782 -n test-all-logs-checks -R example\/fake/);
      assert.match(out, /SUMMARY: CLEAN\+RED \(1 red: Test-All shard checks; the summary check is red with them\)$/m);
      assert.equal(code, 3);
    },
  },
  // #3169 at 5550edf6, the morning's misread: two real reds and the summary. Its review then said NOT CLEAN.
  threeReds: {
    make: () => scenario({ head: H.three, cs: [[comments()[0][0]]], logs: [132551473408, 132551473386, 132555697041] }),
    expect: ({ code, out }) => {
      assert.match(out, /review {6}NOT CLEAN: deciding review of head 5550edf6/);
      assert.match(out, /names 5550edf6 = the current head/);
      assert.match(out, /RED {5}Test-All shard vitest-pwa-1 — failure/);
      assert.match(out, /│ ❯ src\/pages\/EnterpriseNotAProfile\.test\.tsx:212:30/);
      assert.match(out, /test file apps\/pwa\/src\/pages\/EnterpriseNotAProfile\.test\.tsx:212 {2}TOUCHED by this PR/);
      assert.match(out, /RED {5}Test-All shard checks — failure/);
      assert.match(out, /checks {6}19 on this head: 16 success, 3 red, 0 pending/);
      assert.match(out, /SUMMARY: NOT CLEAN \(the last deciding review says NOT CLEAN; CI: 2 reds\)$/m);
      assert.equal(code, 4);
    },
  },
  // #3169 at a8738323: all green, but the last deciding review is about 33a37470.
  oldHead: {
    make: () => scenario({ head: H.green }),
    expect: ({ code, out }) => {
      assert.match(out, /MISMATCH: names 33a37470 \(an older commit of this PR\), the head is a8738323/);
      assert.match(out, /SUMMARY: NOT CLEAN \(MISMATCH: the CLEAN verdict is about 33a37470, not this head; CI: green\)$/m);
      assert.equal(code, 4);
    },
  },
  // The same, with a verdict that names a8738323: green, and a commit status list that is empty (GitHub calls that "pending").
  green: {
    make: () => scenario({ head: H.green, cs: [[...comments()[0], comment('CLEAN — deciding review of head a8738323', '2026-11-14T20:30:00Z')]] }),
    expect: ({ code, out }) => {
      assert.match(out, /names a8738323 = the current head/);
      assert.match(out, /19 on this head: 19 success, 0 red, 0 pending/);
      assert.match(out, /SUMMARY: CLEAN\+GREEN$/m);
      assert.equal(code, 0);
    },
  },
  // In the merge queue, as GitHub recorded it for a queued PR (its mergeable reads UNKNOWN there).
  queued: {
    make: () => scenario({
      head: H.green, cs: [[comment('CLEAN: at head a8738323', '2026-11-14T20:30:00Z')]],
      pr: { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', isInMergeQueue: true, mergeQueueEntry: json('graphql-queued.json').data.repository.pullRequest.mergeQueueEntry },
    }),
    expect: ({ code, out }) => {
      assert.match(out, /^merge queue IN THE QUEUE \(AWAITING_CHECKS, position 2\)$/m);
      assert.match(out, /^mergeable {3}UNKNOWN \(merge state UNKNOWN\)$/m);
      assert.match(out, /SUMMARY: CLEAN\+GREEN$/m);
      assert.equal(code, 0);
    },
  },
  // Clean and green but conflicting with its base: the summary says so.
  conflicting: {
    make: () => scenario({ head: H.green, cs: [[comment('CLEAN: at head a8738323', '2026-11-14T20:30:00Z')]], pr: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' } }),
    expect: ({ code, out }) => {
      assert.match(out, /^mergeable {3}CONFLICTING \(merge state DIRTY\)$/m);
      assert.match(out, /SUMMARY: CLEAN\+GREEN {2}\[CONFLICTING with its base\]$/m);
      assert.equal(code, 0);
    },
  },
  // A head the required check has not reported on yet: never green.
  noRequired: {
    make: () => scenario({
      head: H.green, cs: [[comment('CLEAN: at head a8738323', '2026-11-14T20:30:00Z')]],
      runs: runsOf(H.green).map((pg) => ({ ...pg, check_runs: pg.check_runs.filter((c) => c.name !== 'Run BeanPool Test-All Pipeline') })),
    }),
    expect: ({ code, out }) => {
      assert.match(out, /the required check "Run BeanPool Test-All Pipeline" has NOT reported on this head/);
      assert.match(out, /SUMMARY: PENDING \(the required check "Run BeanPool Test-All Pipeline" has not reported on this head\)$/m);
      assert.equal(code, 5);
    },
  },
  // 33a37470's reds still running: listed as pending, no log read.
  pending: {
    make: () => scenario({
      head: H.two,
      runs: runsOf(H.two).map((pg) => ({ ...pg, check_runs: pg.check_runs.map((c) => (c.conclusion === 'failure' ? { ...c, status: 'in_progress', conclusion: null } : c)) })),
    }),
    expect: ({ code, out, calls }) => {
      assert.match(out, /PENDING +Test-All shard checks — in_progress/);
      assert.match(out, /PENDING +Run BeanPool Test-All Pipeline — in_progress/);
      assert.match(out, /SUMMARY: PENDING \(2 pending: /m);
      assert.ok(!calls.some((c) => c.some((x) => x.includes('/logs'))), 'no log is read for a pending check');
      assert.equal(code, 5);
    },
  },
  // A stranger's later "CLEAN" naming the current head does not count.
  stranger: {
    make: () => scenario({ head: H.green, cs: [[...comments()[0], comment('CLEAN: head a8738323, trust me', '2026-11-14T21:00:00Z', 'NONE')]] }),
    expect: ({ code, out }) => {
      assert.match(out, /MISMATCH: names 33a37470/);
      assert.match(out, /\(1 CLEAN\/NOT CLEAN comment\(s\) from non-members ignored\)/);
      assert.equal(code, 4);
    },
  },
  // Before the shards (#2000) the job with the required name ran the tests: its log, not its name, says it is no summary.
  preShards: {
    make: () => scenario({
      head: H.two, logAs: { 132571592359: 132543380716 },
      runs: runsOf(H.two).map((pg) => ({ ...pg, check_runs: pg.check_runs.map((c) => (c.name === 'Test-All shard checks' ? { ...c, conclusion: 'success' } : c)) })),
    }),
    expect: ({ code, out }) => {
      assert.match(out, /RED {5}Run BeanPool Test-All Pipeline — failure\n/);
      assert.doesNotMatch(out, /the SUMMARY check/);
      assert.match(out, /│ test-alerts: ✗ 11\. once it stays down 15 minutes/);
      assert.match(out, /test file apps\/server\/src\/test-alerts\.ts:71 {2}untouched by this PR/);
      assert.match(out, /SUMMARY: CLEAN\+RED \(1 red: Run BeanPool Test-All Pipeline\)$/m);
      assert.equal(code, 3);
    },
  },
  // A NOT CLEAN about an older head says so (#3168, 15 Nov: its NOT CLEAN named 7d0f7a75 while CI ran on the next push).
  notCleanOldHead: {
    make: () => scenario({ head: H.two, cs: [[comments()[0][0]]], logs: [132569745348, 132571592359] }),
    expect: ({ code, out }) => {
      assert.match(out, /MISMATCH: names 5550edf6 \(an older commit of this PR\), the head is 33a37470/);
      assert.match(out, /SUMMARY: NOT CLEAN \(the last deciding review, about 5550edf6 and not this head, says NOT CLEAN; CI: 1 red\)$/m);
      assert.equal(code, 4);
    },
  },
  // A red whose log GitHub will not give: still listed, and still red.
  noLog: {
    make: () => scenario({ head: H.two, logs: [132571592359] }),
    expect: ({ code, out }) => {
      assert.match(out, /RED {5}Test-All shard checks — failure\n.*\n {10}\(log unreadable: HTTP 404/);
      assert.match(out, /SUMMARY: CLEAN\+RED \(1 red: Test-All shard checks/m);
      assert.equal(code, 3);
    },
  },
};

for (const [name, s] of Object.entries(SCENARIOS)) {
  test(`scenario ${name}`, () => {
    const r = run(s.make());
    s.expect(r);
    onlyReads(r.calls);
    assert.ok(r.calls.some((c) => c[1] === 'graphql'), 'the PR was read');
  });
}

test('the check runs read are the current head\'s (the stand-in has none for any other)', () => {
  const r = run(SCENARIOS.oldHead.make());
  const cr = r.calls.filter((c) => c.some((x) => x.includes('/check-runs')));
  assert.equal(cr.length, 1);
  assert.ok(cr[0].some((x) => x.includes(`/commits/${H.green}/check-runs`)));
});

// ── the pieces, on the recorded logs ────────────────────────────────────────────────────────────────────────────────

test('a server suite red: its ✗ line, the assertion and the suite file with its line', () => {
  const lines = failureLines(log(132543380716));
  const text = lines.map((l) => l.text).join('\n');
  assert.match(text, /^check server_suites +❌ FAIL/m);
  assert.match(text, /^test-alerts: ✗ 11\. once it stays down 15 minutes/m);
  assert.match(text, /test-alerts\.ts:71:15/);
  assert.match(text, /^❌ Server suites failed: test-alerts$/m);
  assert.deepEqual(namedFiles(lines).map((f) => [f.path, f.line, f.test]), [['apps/server/src/test-alerts.ts', 71, true]]);
});

test('an esbuild error names the source file and line, not a test', () => {
  const lines = failureLines(log(132555659030));
  assert.match(lines.map((l) => l.text).join('\n'), /✘ \[ERROR\] No matching export in "stub:expo-router"/);
  assert.deepEqual(namedFiles(lines).map((f) => [f.path, f.line, f.test]), [['apps/native/app/old-words-unlock.tsx', 14, false]]);
});

test('the summary job is told apart by its log; a shard is not', () => {
  assert.equal(isSummaryLog(log(132555697041)), true);
  assert.equal(isSummaryLog(log(132571592359)), true);
  for (const id of [132551473408, 132551473386, 132569745348, 132543380716, 132555659030]) assert.equal(isSummaryLog(log(id)), false, String(id));
});

test('verdicts: CLEAN and NOT CLEAN in the first line only', () => {
  assert.equal(verdictOf('CLEAN — deciding review (Opus 5.5) of head 7e682d07')?.verdict, 'CLEAN');
  assert.equal(verdictOf('NOT CLEAN: two defects')?.verdict, 'NOT CLEAN');
  assert.equal(verdictOf('\n**CLEAN**: nothing new')?.verdict, 'CLEAN');
  assert.equal(verdictOf('Merge gate: REQUEUED head=534cab07e'), null);
  assert.equal(verdictOf('CLEANUP of the old rows'), null);
  assert.equal(verdictOf('Looks good.\nCLEAN'), null);
});

test('the head a verdict names is a commit of the PR, not the first hex-looking number', () => {
  const prCommits = [H.three, H.two, H.green];
  assert.deepEqual(namedHead('CLEAN: run 43632020782 passed at head 33a37470', prCommits), { sha: '33a37470', ofPr: true });
  assert.deepEqual(namedHead('CLEAN: fixes from 5550edf6 hold at 33a37470', prCommits), { sha: '5550edf6', ofPr: true });
  assert.deepEqual(namedHead('CLEAN: at head abcdef1234 (rebased away)', prCommits), { sha: 'abcdef1234', ofPr: false });
  assert.equal(namedHead('CLEAN: nothing found', prCommits), null);
});

test('the guard refuses every gh call that could change something', () => {
  for (const bad of [
    ['pr', 'comment', '1', '--body', 'x'], ['run', 'rerun', '1'], ['pr', 'merge', '1'], ['api', '-X', 'POST', 'repos/x/y/issues/1/comments'],
    ['api', '--method=PATCH', 'repos/x/y/pulls/1'], ['api', 'repos/x/y/issues/1/comments', '-f', 'body=x'],
    ['api', 'graphql', '-f', 'query=mutation{enqueuePullRequest(input:{}){clientMutationId}}'], ['api', 'repos/x/y/dispatches', '--input', 'f'],
  ]) assert.throws(() => assertRead(bad), /refused/, bad.join(' '));
  assertRead(['api', 'graphql', '-f', 'query=query($a:Int!){x}', '-F', 'number=1']);
  assertRead(['api', '--paginate', '--slurp', 'repos/x/y/pulls/1/files?per_page=100']);
});

// ── mutants: one rule broken in a copy of the script, and the test for it must fail ─────────────────────────────────

const SOURCE = readFileSync(SCRIPT, 'utf8');
const MUTANTS = [
  { why: 'a verdict about an old head read as this head\'s', scenario: 'oldHead',
    edits: [['const headMatch = Boolean(named && head && head.startsWith(named.sha));', 'const headMatch = Boolean(named);']] },
  { why: 'the summary job counted as a red of its own', scenario: 'twoReds',
    edits: [['aggregate: c.name === REQUIRED_CHECK,', 'aggregate: false,'], ['c.aggregate = summary;', 'c.aggregate = false;']] },
  { why: 'the summary decided by the name alone (a pre-shard test job read as a summary)', scenario: 'preShards',
    edits: [['c.aggregate = summary;', 'c.aggregate ||= summary;']] },
  { why: 'node --test\'s actual: values dropped (the PR\'s own file goes unnamed)', scenario: 'twoReds', edits: [['items = 3;', 'items = 0;']] },
  { why: 'stack frames under an assertion dropped', scenario: 'twoReds', edits: [['keep(l); frames = 2; continue;', 'keep(l); frames = 0; continue;']] },
  { why: 'every file reported untouched', scenario: 'twoReds', edits: [['return diff.some(', 'return !diff.length && diff.some(']] },
  { why: 'a head with no required check read as green', scenario: 'noRequired', edits: [['if (!required) return { line: `PENDING', 'if (false) return { line: `PENDING']] },
  { why: 'a queued PR shown as out of the queue', scenario: 'queued', edits: [["row('merge queue', p.isInMergeQueue ?", "row('merge queue', false ?"]] },
  { why: 'a conflict with the base left out of the summary', scenario: 'conflicting', edits: [["p.mergeable === 'CONFLICTING' ?", 'false ?']] },
  { why: 'a stranger\'s verdict trusted', scenario: 'stranger', edits: [['.filter((c) => TRUSTED.has(c.who))', '.filter(() => true)']] },
  { why: 'pending checks read as green', scenario: 'pending', edits: [["if (c.status !== 'completed') state = 'pending';", "if (c.status !== 'completed') state = 'success';"]] },
  { why: 'a gh write, with the guard in place: refused, so the run fails', scenario: 'twoReds',
    edits: [['const base = `repos/${repo}`;', "readGh(['pr', 'comment', String(pr), '--body', 'x']); const base = `repos/${repo}`;"]] },
  { why: 'a gh write, with the guard removed: the call log shows it', scenario: 'twoReds', readOnly: true,
    edits: [['  assertRead(args);\n  try {', '  try {'], ['const base = `repos/${repo}`;', "readGh(['pr', 'comment', String(pr), '--body', 'x']); const base = `repos/${repo}`;"]] },
];

for (const [i, m] of MUTANTS.entries()) {
  test(`mutant ${i + 1} goes red: ${m.why}`, () => {
    let src = SOURCE;
    for (const [from, to] of m.edits) {
      assert.ok(src.includes(from), `the mutant's edit no longer applies (refactored?): ${from}`);
      src = src.replace(from, to);
    }
    const file = join(TMP, `mutant-${i + 1}.mjs`);
    writeFileSync(file, src);
    const r = run(SCENARIOS[m.scenario].make(), file);
    // The mutant really ran (read the PR), so it goes red for its own rule and not because it never started.
    assert.ok(r.calls.some((c) => c[1] === 'graphql'), `mutant ${i + 1} never ran:\n${r.out}`);
    const check = m.readOnly ? () => onlyReads(r.calls) : () => SCENARIOS[m.scenario].expect(r);
    assert.throws(check, assert.AssertionError, `mutant ${i + 1} passed the ${m.scenario} test:\n${r.out}`);
  });
}

// board.sh, requeue.sh, tripwire.sh and self-test.sh against a stand-in gh and a throwaway origin: no GitHub, no network.
// Run by test-all.sh (the `workflows` check). What only GitHub can show is walked by self-test.sh --run: docs/merge-gate.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const script = (name) => join(HERE, name);

// The stand-in gh: answers what the scripts ask from a JSON state file, and logs every call. Answers are what the real `--jq`
// would print; self-test.sh's first steps and the PR's smoke of the same queries cover the real ones.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_GH_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(file + '.calls', a.join(' ') + '\n');
const save = () => fs.writeFileSync(file, JSON.stringify(s));
// writeSync: console.log then exit can lose the end of a long answer to a pipe.
const out = (t) => { save(); if (t !== undefined) fs.writeSync(1, t + '\n'); process.exit(0); };
const die = (t) => { save(); console.error(t || 'refused'); process.exit(1); };
const has = (x) => a.includes(x);
const val = (name) => a.find((v) => v.startsWith(name + '='))?.slice(name.length + 1);
const after = (x) => a[a.indexOf(x) + 1];
const byId = (id) => Object.values(s.prs).find((p) => p.id === id);
const WALK = { red: { check: 'failure' }, a: { check: 'success', on: 'merge' }, b: { check: 'success', on: 'out' }, clean: { check: 'success', on: 'merge' } };
if (a[0] === 'pr') {
    const p = s.prs[String(a[2]).split('/').pop()];
    if (a[1] === 'create') {
        const name = /gate-selftest\/(\w+)-/.exec(after('--head'))[1];
        const n = String(s.next++);
        s.prs[n] = { id: 'ID' + n, state: 'OPEN', isDraft: false, base: 'main', head: 'head' + name, mergeable: 'MERGEABLE', labels: [], files: s.land[name]?.files ?? ['x'], patch: '', on: WALK[name].on, land: s.land[name]?.oid };
        s.checks['head' + name] = [WALK[name].check];
        out('https://github.com/x/y/pull/' + n);
    }
    if (a[1] === 'view') {
        const f = after('--json');
        if (!p) die('no PR');
        if (f === 'labels') { if (p.labelsUnreadable) die(); out(p.labels.join('\n') || undefined); }
        if (f === 'headRefOid') out(p.head);
        out([p.id, p.state, p.isDraft, p.base, p.head, p.mergeable].join(' '));
    }
    // As GitHub answered on #2295: PullRequest.diff too_large, HTTP 406, for --name-only as well.
    if (a[1] === 'diff') { if (p.diffUnreadable || p.files.length > 300) die('HTTP 406: Sorry, the diff exceeded the maximum number of files (300).'); out(has('--name-only') ? p.files.join('\n') : p.patch); }
    if (a[1] === 'merge') {
        if (has('--disable-auto')) out();
        if (has('--admin') && s.adminMerges) { p.state = 'MERGED'; out(); }
        die('the base branch policy prohibits the merge');
    }
    if (a[1] === 'close') { p.state = 'CLOSED'; out(); }
    if (a[1] === 'comment') out();
}
if (a[0] === 'run') {
    if (a[1] === 'list') out(s.groupRun);
    const r = s.runs[a[2]];
    if (a[1] === 'rerun') {
        if (r?.rerun === 'refuse') die('cannot be rerun');
        if (r) { r.attempt = 2; r.status = 'completed'; r.conclusion = r.rerun === 'pass' ? 'success' : 'failure'; }
        out();
    }
    if (a[1] === 'view') {
        if (!r) die();
        if (after('--json').startsWith('status')) out([r.status, r.conclusion, r.attempt].join(' '));
        out([r.event, r.headBranch, r.conclusion, r.attempt].join(' '));
    }
}
if (a[0] === 'api') {
    const q = val('query');
    if (a[1] === 'graphql') {
        if (q.includes('mergeQueue(')) out(String(s.queued));
        if (q.includes('enqueuePullRequest')) {
            const p = byId(val('id'));
            (s.enqueued ??= []).push(p.id);
            if (p.on === 'refuse' || val('head') !== p.head) die('not mergeable');
            if (p.on === 'merge') { p.state = 'MERGED'; p.mergeCommit = p.land; if (p.mergedHead) p.head = p.mergedHead; }
            if (p.on === 'stay') p.inQueue = true;
            out(p.on === 'null' ? 'null' : '1');
        }
        const p = s.prs[val('number')];
        if (!p) die();
        out([p.state, !!p.inQueue, p.head, p.mergeCommit ?? 'none'].join(' '));
    }
    const path = a.find((v) => v.startsWith('repos/')) ?? '';
    if (path.includes('/check-runs')) {
        const sha = /commits\/([^/]+)\//.exec(path)[1];
        if (s.unreadableChecks) die();
        out((s.checks[sha] ?? []).join('\n') || undefined);
    }
    if (path.includes('/rulesets/')) out(s.ruleset);
    if (path.includes('/git/ref/heads/main')) out('mainsha');
    const files = /pulls\/(\d+)\/files/.exec(path);
    if (files) {
        const p = s.prs[files[1]];
        if (p.diffUnreadable) die();
        out(after('--jq').includes('patch') ? p.patch : p.files.join('\n'));
    }
    if (path.includes('/contents/') && !has('-X')) out('blobsha');
    out();
}
die('fake gh: no answer for ' + a.join(' '));
`;

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.invalid' };

/** A throwaway origin with main's money list, a clone of it, and the stand-in gh. */
function world(fn) {
    const dir = mkdtempSync(join(tmpdir(), 'merge-queue-'));
    try {
        const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const origin = join(dir, 'origin.git');
        const seed = join(dir, 'seed');
        mkdirSync(join(seed, 'scripts'), { recursive: true });
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
        git(seed, 'init', '-q', '-b', 'main');
        git(seed, 'remote', 'add', 'origin', origin);
        copyFileSync(join(ROOT, 'scripts/test-all-train.sh'), join(seed, 'scripts/test-all-train.sh'));
        git(seed, 'add', '.');
        git(seed, 'commit', '-q', '-m', 'main');
        const land = (file, text = 'x\n') => {
            mkdirSync(dirname(join(seed, file)), { recursive: true });
            writeFileSync(join(seed, file), text);
            git(seed, 'add', file);
            git(seed, 'commit', '-q', '-m', `land ${file}`);
            git(seed, 'push', '-q', 'origin', 'main');
            return git(seed, 'rev-parse', 'HEAD');
        };
        const drop = (file) => {
            git(seed, 'rm', '-q', file);
            git(seed, 'commit', '-q', '-m', `drop ${file}`);
            git(seed, 'push', '-q', 'origin', 'main');
            return git(seed, 'rev-parse', 'HEAD');
        };
        git(seed, 'push', '-q', 'origin', 'main');
        const clone = join(dir, 'clone');
        git(dir, 'clone', '-q', origin, clone);
        const bin = join(dir, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'gh'), FAKE_GH);
        chmodSync(join(bin, 'gh'), 0o755);
        writeFileSync(join(bin, 'pnpm'), '#!/bin/bash\nexit 0\n');
        chmodSync(join(bin, 'pnpm'), 0o755);
        const stateFile = join(dir, 'state.json');
        const state = { prs: {}, checks: {}, runs: {}, groupRun: '', ruleset: '0 deletion,merge_queue', queued: 0, next: 900, land: {}, ...{} };
        const save = () => writeFileSync(stateFile, JSON.stringify(state));
        const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
        const pr = (n, over = {}) => {
            const head = over.head ?? `${n}${'a'.repeat(40 - String(n).length)}`;
            state.prs[n] = { id: `ID${n}`, state: 'OPEN', isDraft: false, base: 'main', head, mergeable: 'MERGEABLE', labels: [], files: ['apps/pwa/src/x.tsx'], patch: '+const x = 1;\n', on: 'stay', ...over };
            state.checks[head] ??= ['success'];
            return head;
        };
        const exec = (name, args = [], env = {}) => {
            save();
            const r = spawnSync('bash', [script(name), ...args], {
                encoding: 'utf8', timeout: 60_000,
                env: { ...process.env, ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, BOARD_ROOT: clone, BOARD_POLL_SECS: '0', BOARD_WAIT_MINS: '1', MERGE_QUEUE_WAIT_SECS: '0', MERGE_QUEUE_WAIT_TRIES: '2', MERGE_QUEUE_RETRY_SECS: '0', ...env },
            });
            return { status: r.status, out: `${r.stdout}${r.stderr}`, state: read() };
        };
        const board = (args, env) => exec('board.sh', args.map(String), env);
        const calls = () => (existsSync(`${stateFile}.calls`) ? readFileSync(`${stateFile}.calls`, 'utf8') : '');
        const journal = () => { const f = join(clone, '.git/test-all-queue/journal.log'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
        const setJournal = (t) => { mkdirSync(join(clone, '.git/test-all-queue'), { recursive: true }); writeFileSync(join(clone, '.git/test-all-queue/journal.log'), t); };
        fn({ dir, clone, git, land, drop, state, pr, exec, board, calls, journal, setJournal });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const plan = (w, ...prs) => w.board(prs, { BOARD_PLAN_ONLY: '1' });

test('the plan: tier-A and money first, in the order given, then the rest in the order given', () => world((w) => {
    w.pr(1); w.pr(2); w.pr(3, { labels: ['tier-A'] }); w.pr(4, { files: ['apps/server/src/engine/escrow.ts'] }); w.pr(5, { labels: ['Tier-A', 'x'] });
    const r = plan(w, 1, 3, 2, 4, 5);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.out.trim(), ['queue 1', 'queue 3 first (tier-A)', 'queue 2', 'queue 4 first (money path)', 'queue 5 first (tier-A)'].join('\n'));
    assert.equal(r.state.enqueued, undefined, 'a plan queues nothing');
    assert.equal(w.journal(), '', 'a plan journals nothing');
}));

test('a changed line that writes a balance counts as money, in any file; a line that only reads one does not', () => world((w) => {
    w.pr(1, { patch: '--- a/x.ts\n+++ b/x.ts\n+  db.prepare("UPDATE accounts SET balance = ?").run(1);\n' });
    w.pr(2, { patch: '-  conservingTransaction(db, () => {});\n' });
    w.pr(3, { patch: '+  const balance = 1;\n+  // AND balance = 0\n' });
    w.pr(4, { patch: '+  db.exec("update accounts set balance = 0");\n' });
    assert.equal(plan(w, 1, 2, 3, 4).out.trim(), ['queue 1 first (money line)', 'queue 2 first (money line)', 'queue 3', 'queue 4 first (money line)'].join('\n'), 'SQL in any case: the train reads these with git diff -i');
}));

test('a PR of over 300 files is boarded and read in full: GitHub refuses its diff, and 9 of the last 17 guide publishes are that size', () => world((w) => {
    const files = Array.from({ length: 1528 }, (_, i) => `apps/website/guide/page-${i}.html`);
    w.pr(1, { files });
    w.pr(2, { files: ['apps/server/src/engine/escrow.ts', ...files] });
    w.pr(3, { files, patch: `${'+  a line of a page\n'.repeat(20_000)}+  conservingTransaction(db, () => {});\n${'+  a line of a page\n'.repeat(20_000)}` });
    const r = plan(w, 1, 2, 3);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.out.trim(), ['queue 1', 'queue 2 first (money path)', 'queue 3 first (money line)'].join('\n'));
}));

test('each reason to leave a PR out names it, and the others still go', () => world((w) => {
    w.pr(1);
    w.pr(2, { state: 'MERGED' });
    w.pr(3, { isDraft: true });
    w.pr(4, { base: 'other' });
    w.pr(5, { mergeable: 'CONFLICTING' });
    w.pr(6, { labelsUnreadable: true });
    w.pr(7, { diffUnreadable: true });
    w.pr(8, { files: [] });
    const r = plan(w, 1, 2, 3, 4, 5, 6, 7, 8, 80);
    for (const line of ['#2 already merged', '#3 left out: a draft', '#4 left out: based on other, not main', '#5 left out: conflicts with main', '#6 left out: labels unreadable', '#7 left out: changes unreadable', '#8 left out: changes unreadable', '#80 left out: PR unreadable', 'queue 1']) assert.ok(r.out.includes(line), `${line}\n${r.out}`);
}));

test('a head that is not the cleared one is left out; the cleared head, whole or short, goes', () => world((w) => {
    const head = w.pr(1);
    assert.match(plan(w, '1@bbbbbbb').out, /#1 left out: head moved: cleared bbbbbbb, now 1aaaaaaaa/);
    assert.match(plan(w, `1@${head.slice(0, 8)}`).out, /queue 1/);
    assert.match(plan(w, `1@${head}`).out, /queue 1/);
    assert.match(plan(w, 'https://github.com/x/y/pull/1').out, /queue 1/);
}));

test('a PR already merged says so and counts as merged; a closed one does not', () => world((w) => {
    w.pr(1, { state: 'MERGED' }); w.pr(2, { state: 'CLOSED' });
    const merged = w.board([1]);
    assert.equal(merged.status, 0, merged.out);
    assert.match(merged.out, /#1 already merged/);
    assert.match(merged.out, /#1 MERGED/);
    assert.doesNotMatch(merged.out, /NOT merged/);
    const closed = w.board([2]);
    assert.equal(closed.status, 1, closed.out);
    assert.match(closed.out, /#2 NOT merged: left out: it is CLOSED/);
}));

test('every gh call on a PR names the repository: a bare number once reached another repository', () => {
    for (const name of ['board.sh', 'requeue.sh', 'self-test.sh', 'lib.sh']) {
        // Commands, not words: a quoted message may name one.
        const commands = readFileSync(script(name), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#') && /\bgh (pr|run) /.test(l.replace(/"[^"$]*"/g, '""')));
        assert.ok(commands.length > 0 || name === 'lib.sh', `${name}: the pattern still finds its gh calls`);
        for (const line of commands) {
            assert.match(line, /-R "\$REPO"/, `${name}: ${line.trim()}`);
        }
    }
});

test('usage: no PR, a word, the same PR twice', () => world((w) => {
    w.pr(1);
    assert.equal(w.board([]).status, 2);
    assert.equal(w.board(['abc']).status, 2);
    assert.equal(w.board(['1', '1']).status, 2);
}));

test('no money list on main, no board: an empty list would pass every PR', () => world((w) => {
    w.pr(1);
    w.drop('scripts/test-all-train.sh');
    const r = w.board([1]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /money list is unreadable/);
    assert.equal(r.state.enqueued, undefined);
}));

test('a green PR is queued with the head read, lands, is verified by its files, and the board says so', () => world((w) => {
    const oid = w.land('apps/pwa/src/x.tsx');
    const head = w.pr(1, { on: 'merge', land: oid });
    const r = w.board([1]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /#1 queued at position 1, head 1aaaaaaaa/);
    assert.match(r.out, /apps\/pwa\/src\/x\.tsx/, 'the --stat of the landing');
    assert.match(r.out, /#1 MERGED/);
    assert.deepEqual(r.state.enqueued, ['ID1']);
    assert.match(w.journal(), new RegExp(`pr=1 QUEUED head=${head.slice(0, 9)} position=1`));
    assert.match(w.journal(), new RegExp(`pr=1 LANDED sha=${oid.slice(0, 9)}`));
    assert.doesNotMatch(w.calls(), /pr merge/, 'the board never calls gh pr merge, so it can never pass --admin');
}));

test('a head not green is not queued: red, cancelled, no run, pending and skipped all hold', () => {
    for (const [checks, says] of [[['failure'], 'is red'], [['timed_out'], 'is red'], [['cancelled'], 'is cancelled'], [[], 'is still none'], [['pending'], 'is still pending'], [['skipped'], 'is still pending'], [['neutral'], 'is still pending']]) {
        world((w) => {
            const head = 'c'.repeat(40);
            w.state.checks[head] = checks;
            w.pr(1, { head });
            const r = w.board([1]);
            assert.equal(r.status, 1, r.out);
            assert.ok(r.out.includes(`#1 left out: GitHub Test-All on ccccccccc ${says}`), `${checks}: ${r.out}`);
            assert.equal(r.state.enqueued, undefined, `${checks}: not queued`);
            assert.match(r.out, /#1 NOT merged/);
        });
    }
});

test('GitHub unreadable holds, and the PR after it still goes', () => world((w) => {
    w.pr(1); w.state.unreadableChecks = true;
    const r = w.board([1]);
    assert.equal(r.status, 1);
    assert.match(r.out, /#1 left out: GitHub Test-All on \w+ is unknown/);
}));

test('a refusal from the queue is a line; the other PRs still go', () => world((w) => {
    const oid = w.land('apps/pwa/src/x.tsx');
    w.pr(1, { on: 'refuse' }); w.pr(2, { on: 'merge', land: oid });
    const r = w.board([1, 2]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#1 left out: the queue refused it: not mergeable/);
    assert.match(r.out, /#2 MERGED/);
}));

test('a PR the queue takes out stays out: named, journalled, and that head refused until requeue sends it back', () => world((w) => {
    const head = w.pr(1, { on: 'out' });
    w.state.groupRun = '77 failure';
    const enqueues = () => (w.calls().match(/query=mutation/g) ?? []).length;
    const r = w.board([1]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /#1 taken out of the queue \(state OPEN, run 77 failure\)/);
    assert.equal(enqueues(), 1, 'no automatic second try');
    assert.match(w.journal(), new RegExp(`pr=1 OUT head=${head.slice(0, 9)}`));
    const again = w.board([1]);
    assert.equal(again.status, 1, again.out);
    assert.match(again.out, /#1 left out: the queue took this head out/);
    assert.equal(enqueues(), 1, 'boarding it again by hand does not get round the rerun rule');
    w.setJournal(`${w.journal()}2026-11-01 10:00:00 pr=1 REQUEUED head=${head.slice(0, 9)} run=77 passed\n`);
    assert.match(w.board([1]).out, /#1 queued/, 'requeue.sh opens it again');
    assert.match(w.board([1]).out, /#1 left out: the queue took this head out/, 'once');
    const newHead = 'd'.repeat(40);
    w.pr(1, { head: newHead, on: 'stay' });
    assert.match(w.board([1], { BOARD_WAIT_MINS: '0' }).out, /#1 queued/, 'a new head is a new PR');
}));

test('merged is not landed: the wrong head, a commit not on main, or other files are each NOT VERIFIED', () => {
    world((w) => {
        const oid = w.land('apps/pwa/src/x.tsx');
        w.pr(1, { on: 'merge', land: oid, mergedHead: 'e'.repeat(40) });
        const r = w.board([1]);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /#1 NOT VERIFIED: the head that merged is e+, not the one queued/);
        assert.match(w.journal(), /pr=1 NOT-LANDED/);
    });
    world((w) => {
        w.pr(1, { on: 'merge', land: 'f'.repeat(40) });
        assert.match(w.board([1]).out, /#1 NOT VERIFIED: f+ is not on origin\/main/);
    });
    world((w) => {
        const oid = w.land('apps/pwa/src/other.tsx');
        const r = w.board.call(null, [(w.pr(1, { on: 'merge', land: oid }), 1)]);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /#1 NOT VERIFIED: the files on main are not the PR's/);
    });
});

test('still queued at the time limit: said, and nothing done to it', () => world((w) => {
    w.pr(1, { on: 'stay' });
    const r = w.board([1], { BOARD_WAIT_MINS: '0' });
    assert.equal(r.status, 1);
    assert.match(r.out, /#1 still in the queue after 0 min/);
}));

const redRun = (w, over = {}) => { w.state.runs[77] = { event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1-abc', conclusion: 'failure', attempt: 1, status: 'completed', rerun: 'pass', ...over }; };
const requeue = (w, ...args) => w.exec('requeue.sh', ['1', '--run', '77', '--why', 'test-x timed out at 300 s', ...args]);

test('requeue: the failed jobs get one rerun, then only a whole new queue run can land it', () => world((w) => {
    const oid = w.land('apps/pwa/src/x.tsx');
    const head = w.pr(1, { on: 'merge', land: oid });
    redRun(w);
    const r = requeue(w);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /#1 MERGED/);
    assert.match(w.calls(), /run rerun 77 -R \S+ --failed/);
    assert.match(w.calls(), /pr comment 1 .*RERUN head=/);
    assert.match(w.journal(), new RegExp(`pr=1 RERUN head=${head.slice(0, 9)} run=77 decided by the director: test-x timed out at 300 s`));
    assert.match(w.journal(), /pr=1 REQUEUED head=/);
}));

test('requeue: a rerun that fails stays out, and nothing is queued', () => world((w) => {
    w.pr(1); redRun(w, { rerun: 'fail' });
    const r = requeue(w);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.state.enqueued, undefined);
    assert.match(w.journal(), /pr=1 RED run=77 failed its rerun/);
}));

test('requeue: when GitHub will not rerun a dead group, the new queue run is the one rerun', () => world((w) => {
    w.pr(1, { on: 'stay' }); redRun(w, { rerun: 'refuse' });
    const r = w.exec('requeue.sh', ['1', '--run', '77', '--why', 'a timeout'], { BOARD_WAIT_MINS: '0' });
    assert.match(r.out, /#1 queued/);
    assert.match(w.journal(), /pr=1 REQUEUED head=\w+ run=77: GitHub would not rerun/);
}));

test('requeue: one rerun at most, for this head, by this script or by hand', () => world((w) => {
    const head = w.pr(1); redRun(w);
    w.setJournal(`2026-11-01 10:00:00 pr=1 RERUN head=${head.slice(0, 9)} run=70 decided by the director: x\n`);
    const r = requeue(w);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /has had its rerun\. A second red is real/);
    assert.doesNotMatch(w.calls(), /run rerun/);
    w.setJournal('');
    redRun(w, { attempt: 2 });
    assert.match(requeue(w).out, /run 77 is on attempt 2/);
    assert.doesNotMatch(w.calls(), /run rerun/);
}));

test('requeue: only this PR\'s red merge queue run, and only a PR out of the queue', () => world((w) => {
    w.pr(1); redRun(w, { event: 'pull_request' });
    assert.match(requeue(w).out, /is a pull_request run, not a merge queue run/);
    redRun(w, { headBranch: 'gh-readonly-queue/main/pr-11-abc' });
    assert.match(requeue(w).out, /not #1's/);
    redRun(w, { conclusion: 'success' });
    assert.match(requeue(w).out, /is success, not a failure/);
    redRun(w);
    w.pr(1, { inQueue: true });
    assert.match(requeue(w).out, /not a PR out of the queue/);
    assert.doesNotMatch(w.calls(), /run rerun/);
    assert.equal(w.exec('requeue.sh', ['1', '--run', '77']).status, 2, 'no reason, no rerun');
}));

test('requeue: a PR taken out with nothing red comes back once, and never past a red run', () => world((w) => {
    const head = w.pr(1, { on: 'stay' });
    const noRun = () => w.exec('requeue.sh', ['1', '--no-run', '--why', 'the queue timed out on a stuck runner'], { BOARD_WAIT_MINS: '0' });
    w.state.groupRun = '77 failure';
    assert.match(noRun().out, /queue run 77 is red: read it, and use --run 77/);
    assert.equal(w.journal(), '', 'nothing spent');
    w.state.groupRun = '77 cancelled';
    w.setJournal(`2026-11-01 10:00:00 pr=1 OUT head=${head.slice(0, 9)} taken out\n`);
    assert.match(noRun().out, /#1 queued/);
    assert.match(w.journal(), /pr=1 RERUN head=\w+ no red run, decided by the director: the queue timed out/);
    assert.match(w.journal(), /pr=1 REQUEUED head=/);
    assert.match(noRun().out, /has had its rerun/, 'the same one rerun');
    assert.equal(w.exec('requeue.sh', ['1', '--no-run', '--run', '77', '--why', 'x']).status, 2, 'one or the other');
}));

const lockIn = (w) => ({ TRIPWIRE_LOCK: join(w.dir, 'heavy.lock'), TRIPWIRE_LOCK_SECS: '0', TRIPWIRE_LOCK_TRIES: '2' });

test('tripwire: journals green or red, holds nothing, and gives the lock back', () => world((w) => {
    const env = lockIn(w);
    const green = w.exec('tripwire.sh', [], { ...env, TRIPWIRE_RUN: 'true' });
    assert.equal(green.status, 0, green.out);
    assert.match(w.journal(), /pr=tripwire TRIPWIRE green sha=/);
    assert.equal(existsSync(env.TRIPWIRE_LOCK), false, 'the lock is released');
    const red = w.exec('tripwire.sh', [], { ...env, TRIPWIRE_RUN: 'false' });
    assert.equal(red.status, 1, red.out);
    assert.match(w.journal(), /pr=tripwire TRIPWIRE red sha=\w+: read the run; this holds no merge/);
    assert.equal(existsSync(env.TRIPWIRE_LOCK), false);
    assert.equal(w.calls(), '', 'it asks GitHub for nothing and touches no PR');
    assert.equal(w.git(w.clone, 'worktree', 'list').split('\n').length, 1, 'its scratch worktree is gone');
}));

test('tripwire: a lock held by another run stays theirs', () => world((w) => {
    const env = lockIn(w);
    mkdirSync(env.TRIPWIRE_LOCK);
    writeFileSync(join(env.TRIPWIRE_LOCK, 'owner'), 'pid=1 since=1 somebody\n');
    const r = w.exec('tripwire.sh', [], { ...env, TRIPWIRE_RUN: 'true' });
    assert.equal(r.status, 1, r.out);
    assert.match(w.journal(), /TRIPWIRE not run: the heavy-test lock stayed held/);
    assert.equal(readFileSync(join(env.TRIPWIRE_LOCK, 'owner'), 'utf8'), 'pid=1 since=1 somebody\n');
}));

const walkReady = (w) => {
    w.state.land.a = { oid: w.land('scripts/merge-queue/selftest-a.marker'), files: ['scripts/merge-queue/selftest-a.marker'] };
    w.state.land.clean = { oid: w.drop('scripts/merge-queue/selftest-a.marker'), files: ['scripts/merge-queue/selftest-a.marker'] };
    w.state.groupRun = '88 failure';
    w.state.runs[88] = { event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-901-abc', conclusion: 'failure', attempt: 1, status: 'completed', rerun: 'fail' };
};

test('self-test: with no argument it prints the walk and touches nothing', () => world((w) => {
    const r = w.exec('self-test.sh');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /A PR with a failing test/);
    assert.match(r.out, /--run/);
    assert.equal(w.calls(), '');
}));

test('self-test: refuses to start with a bypass, with no queue, or with PRs in the queue', () => world((w) => {
    w.state.ruleset = '1 deletion,merge_queue';
    assert.match(w.exec('self-test.sh', ['--run']).out, /still has a bypass actor/);
    w.state.ruleset = '0 deletion,pull_request';
    assert.match(w.exec('self-test.sh', ['--run']).out, /has no merge queue/);
    w.state.ruleset = '0 deletion,merge_queue'; w.state.queued = 2;
    const r = w.exec('self-test.sh', ['--run']);
    assert.equal(r.status, 2);
    assert.match(r.out, /holds 2 PRs/);
    assert.doesNotMatch(w.calls(), /pr create|git\/refs/, 'nothing opened');
}));

test('self-test: the whole walk, where the gate holds, says PROVED and closes what it opened', () => world((w) => {
    walkReady(w);
    const r = w.exec('self-test.sh', ['--run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PROVED: the gate said red/);
    assert.equal(r.state.prs[900].state, 'CLOSED', 'the red PR');
    assert.equal(r.state.prs[901].state, 'MERGED', 'PR a landed');
    assert.equal(r.state.prs[902].state, 'CLOSED', 'PR b, taken out');
    assert.equal(r.state.prs[903].state, 'MERGED', 'the clean-up landed');
    assert.match(w.calls(), /-X DELETE repos\/\S+\/git\/refs\/heads\/gate-selftest\/red-/);
    assert.match(w.journal(), /pr=gate-selftest SELFTEST proved/);
}));

test('self-test: --admin merging the red PR is NOT PROVED, and it stops there', () => world((w) => {
    walkReady(w); w.state.adminMerges = true;
    const r = w.exec('self-test.sh', ['--run']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /❌ gh pr merge --admin was accepted/);
    assert.match(r.out, /selftest-red\.marker is on main/);
    assert.doesNotMatch(r.out, /PROVED: the gate said red/);
}));

test('self-test: a PR that should have been taken out landing is NOT PROVED', () => world((w) => {
    walkReady(w);
    w.state.land.b = { oid: w.state.land.a.oid, files: w.state.land.a.files };
    const fake = readFileSync(join(w.dir, 'bin/gh'), 'utf8').replace("b: { check: 'success', on: 'out' }", "b: { check: 'success', on: 'merge' }");
    writeFileSync(join(w.dir, 'bin/gh'), fake);
    const r = w.exec('self-test.sh', ['--run']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /both markers are on main/);
    assert.doesNotMatch(r.out, /PROVED: the gate said red/);
}));

test('self-test: a walk where a red PR never went red proves nothing', () => world((w) => {
    walkReady(w);
    const fake = readFileSync(join(w.dir, 'bin/gh'), 'utf8').replace("red: { check: 'failure' }", "red: { check: 'success' }");
    writeFileSync(join(w.dir, 'bin/gh'), fake);
    const r = w.exec('self-test.sh', ['--run']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /went green: the failing test did not fail it/);
}));

test('selftest.test.mjs says red for each marker it exists for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selftest-'));
    try {
        copyFileSync(script('selftest.test.mjs'), join(dir, 'selftest.test.mjs'));
        // Without NODE_TEST_CONTEXT: a run inside this test runner inherits it, reports to the parent and exits 0 whatever failed.
        const { NODE_TEST_CONTEXT: _, ...env } = process.env;
        const run = () => spawnSync(process.execPath, ['--test', join(dir, 'selftest.test.mjs')], { encoding: 'utf8', env });
        assert.equal(run().status, 0, 'no markers: green');
        writeFileSync(join(dir, 'selftest-a.marker'), '');
        assert.equal(run().status, 0, 'a alone: green');
        rmSync(join(dir, 'selftest-a.marker'));
        writeFileSync(join(dir, 'selftest-b.marker'), '');
        assert.equal(run().status, 0, 'b alone: green');
        writeFileSync(join(dir, 'selftest-a.marker'), '');
        assert.equal(run().status, 1, 'a and b together: red');
        rmSync(join(dir, 'selftest-a.marker'));
        rmSync(join(dir, 'selftest-b.marker'));
        writeFileSync(join(dir, 'selftest-red.marker'), '');
        assert.equal(run().status, 1, 'the red marker: red');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// scripts/sync-pr.sh and the word-catalog merge driver (scripts/words-merge-3way.mjs --driver), against a throwaway
// origin and a stand-in gh: no GitHub, no network.
//
//   node --test scripts/sync-pr.test.mjs
//
// The three cases the brief named (15 Nov): both sides added keys to one catalog (merged, both kept, pushed); one key
// added with different words on each side (stops, nothing pushed); a code conflict (stops, nothing pushed). Plus a red
// words check (stops), --keep, an already-synced PR, a fork, and the driver on its own. Each fixture first proves its
// conflict is real with a plain git merge, so a green run cannot come from a fixture that no longer conflicts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SYNC = path.join(HERE, 'sync-pr.sh');
const MERGER = path.join(HERE, 'words-merge-3way.mjs');
const CAT = 'apps/pwa/words/fr.json';

const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'sync-pr-test-')));
process.on('exit', () => rmSync(T, { recursive: true, force: true }));
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_GLOBAL: path.join(T, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: `${path.join(T, 'bin')}${path.delimiter}${process.env.PATH}`,
    FAKE_GH: path.join(T, 'gh'),
    SYNC_PR_WORDS_CHECK: `echo ran >> '${path.join(T, 'check.log')}'`,
};
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'BEANPOOL_WORDS_MAIN']) delete env[k];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const catalog = (draftedBy, updated, kv) => `${JSON.stringify({ _meta: { language: 'fr', draftedBy, updated }, ...kv }, null, 2)}\n`;
const put = (dir, file, text) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };
const BASE_WORDS = { Hello: 'Bonjour', Bye: 'Au revoir' };
const DE = 'apps/pwa/words/de.json';
const DE_WORDS = { Hello: 'Hallo', One: 'Eins', Two: 'Zwei', Three: 'Drei', Bye: 'Tschuess' };

// ── The fixture: origin, a clone, main moved on, five PR branches made before it moved ──────────────────────────────
writeFileSync(path.join(T, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
mkdirSync(path.join(T, 'bin'));
mkdirSync(path.join(T, 'gh'));
writeFileSync(path.join(T, 'bin', 'gh'), '#!/bin/sh\n[ "$1 $2" = "pr view" ] || exit 1\n[ -f "$FAKE_GH/pr-$3.tsv" ] || exit 1\ncat "$FAKE_GH/pr-$3.tsv"\n');
chmodSync(path.join(T, 'bin', 'gh'), 0o755);
const pr = (n, branch, cross = 'false', state = 'OPEN', base = 'main') => writeFileSync(path.join(T, 'gh', `pr-${n}.tsv`), `${branch}\t${base}\t${cross}\t${state}\n`);

const ORIGIN = path.join(T, 'origin.git');
const W = path.join(T, 'work');
git(T, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
git(T, 'init', '-q', '-b', 'main', W);
git(W, 'remote', 'add', 'origin', ORIGIN);
put(W, CAT, catalog('base', '2026-11-01', BASE_WORDS));
put(W, 'src/app.ts', 'export const a = 1;\n');
put(W, DE, catalog('base', '2026-11-01', DE_WORDS));
git(W, 'add', '.');
git(W, 'commit', '-q', '-m', 'base');
const BASE = git(W, 'rev-parse', 'HEAD');

function branch(name, files) {
    git(W, 'checkout', '-q', '-b', name, BASE);
    for (const [f, text] of Object.entries(files)) put(W, f, text);
    git(W, 'add', '.');
    git(W, 'commit', '-q', '-m', name);
}
// Every branch adds its key where main adds Dog (after Bye) and appends a draftedBy note: the lines git sees clash.
branch('feat/cat', { [CAT]: catalog('base; #1 note', '2026-11-01', { ...BASE_WORDS, Cat: 'Chat' }) });
branch('feat/dog', { [CAT]: catalog('base; #2 note', '2026-11-01', { ...BASE_WORDS, Dog: 'Chienne' }) });
branch('feat/code', { [CAT]: catalog('base; #3 note', '2026-11-01', { ...BASE_WORDS, Owl: 'Hibou' }), 'src/app.ts': 'export const a = 3;\n' });
branch('feat/bird', { [CAT]: catalog('base; #4 note', '2026-11-01', { ...BASE_WORDS, Bird: 'Oiseau' }) });
branch('feat/fox', { [CAT]: catalog('base; #5 note', '2026-11-01', { ...BASE_WORDS, Fox: 'Renard' }) });
// A base with no .gitattributes (a branch older than the driver) that added "Cat" near the top, and a PR that added it at
// the bottom: lines apart, so plain git merges them with the key written twice and the driver never sees the file.
branch('release', { [DE]: catalog('base', '2026-11-01', { Hello: 'Hallo', Cat: 'Katze', One: 'Eins', Two: 'Zwei', Three: 'Drei', Bye: 'Tschuess' }) });
branch('feat/mieze', { [DE]: catalog('base', '2026-11-01', { ...DE_WORDS, Cat: 'Mieze' }) });
// main moves on: a key of its own, its note, a code line, and (as when this lands) the .gitattributes the branches lack.
git(W, 'checkout', '-q', 'main');
put(W, CAT, catalog('base; main note', '2026-11-02', { ...BASE_WORDS, Dog: 'Chien' }));
put(W, 'src/app.ts', 'export const a = 2;\n');
put(W, '.gitattributes', readFileSync(path.join(REPO, '.gitattributes'), 'utf8'));
git(W, 'add', '.');
git(W, 'commit', '-q', '-m', 'main moves on');
const MAIN = git(W, 'rev-parse', 'HEAD');
git(W, 'push', '-q', 'origin', 'main', 'feat/cat', 'feat/dog', 'feat/code', 'feat/bird', 'feat/fox', 'release', 'feat/mieze');
pr(1, 'feat/cat'); pr(2, 'feat/dog'); pr(3, 'feat/code'); pr(4, 'feat/bird'); pr(5, 'feat/fox'); pr(9, 'feat/cat', 'true');
pr(6, 'feat/mieze', 'false', 'OPEN', 'release');

const remoteHead = (b) => git(W, 'ls-remote', 'origin', `refs/heads/${b}`).split('\t')[0];
const sync = (n, extraEnv = {}, ...args) => spawnSync('bash', [SYNC, String(n), ...args], { cwd: W, env: { ...env, ...extraEnv }, encoding: 'utf8' });
const wt = (n) => path.join(W, '.claude', 'worktrees', `sync-pr-${n}`);
const checks = () => (existsSync(path.join(T, 'check.log')) ? readFileSync(path.join(T, 'check.log'), 'utf8').split('\n').filter(Boolean).length : 0);

/** A plain git merge (no driver) of main into the branch: the files it leaves unmerged. Proves the fixture conflicts. */
function plainConflicts(b) {
    git(W, 'checkout', '-q', '--detach', `origin/${b}`);
    spawnSync('git', ['merge', '--no-edit', 'origin/main'], { cwd: W, env, encoding: 'utf8' });
    const u = git(W, 'diff', '--name-only', '--diff-filter=U');
    spawnSync('git', ['merge', '--abort'], { cwd: W, env });
    git(W, 'checkout', '-q', 'main');
    return u.split('\n').filter(Boolean).sort();
}

test('the fixtures conflict in plain git: catalog only for #1, #2, #4; catalog and code for #3', () => {
    git(W, 'fetch', '-q', 'origin');
    assert.deepEqual(plainConflicts('feat/cat'), [CAT]);
    assert.deepEqual(plainConflicts('feat/dog'), [CAT]);
    assert.deepEqual(plainConflicts('feat/code'), [CAT, 'src/app.ts']);
    assert.deepEqual(plainConflicts('feat/bird'), [CAT]);
});

test('both sides added keys to one catalog: merged per key, both kept, words checked, pushed', () => {
    const before = remoteHead('feat/cat');
    const n0 = checks();
    const r = sync(1);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const head = remoteHead('feat/cat');
    assert.notEqual(head, before);
    assert.match(r.stdout, new RegExp(`^head ${head}$`, 'm'), 'prints the new head, which is what origin has');
    assert.match(r.stdout, /1 word catalog\(s\) both sides changed merged per key/);
    assert.equal(git(W, 'rev-parse', `${head}^1`), before, 'a merge on top of the branch (never a rewrite)');
    assert.equal(git(W, 'rev-parse', `${head}^2`), MAIN, 'with main as the second parent');
    const merged = JSON.parse(git(W, 'show', `${head}:${CAT}`));
    assert.deepEqual(Object.keys(merged), ['_meta', 'Hello', 'Bye', 'Cat', 'Dog']);
    assert.equal(merged.Cat, 'Chat');
    assert.equal(merged.Dog, 'Chien');
    assert.equal(merged._meta.draftedBy, 'base; main note; #1 note', "main's note, then the PR's");
    assert.equal(merged._meta.updated, '2026-11-02');
    assert.equal(git(W, 'show', `${head}:src/app.ts`), 'export const a = 2;', "main's code line, which the PR never touched");
    assert.equal(checks(), n0 + 1, 'the words check ran on the merge');
    assert.equal(existsSync(wt(1)), false, 'the worktree is removed');
});

test('a PR already synced: nothing to do, nothing pushed', () => {
    const before = remoteHead('feat/cat');
    const r = sync(1);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to do/);
    assert.equal(remoteHead('feat/cat'), before);
});

test('one key added with different words on each side: stops, nothing pushed', () => {
    const before = remoteHead('feat/dog');
    const r = sync(2);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /STOP, nothing pushed/);
    assert.match(r.stderr, /word catalogs that cannot be merged per key: .*both sides changed "Dog"/);
    assert.equal(remoteHead('feat/dog'), before);
    assert.equal(existsSync(wt(2)), false);
    assert.doesNotMatch(git(W, 'worktree', 'list'), /sync-pr-2/);
});

test('a code conflict: stops, names the file, nothing pushed (its catalog would have merged)', () => {
    const before = remoteHead('feat/code');
    const r = sync(3);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /conflicts outside the word catalogs: src\/app\.ts/);
    assert.doesNotMatch(r.stderr, /cannot be merged per key/, 'the catalog itself merged per key');
    assert.equal(remoteHead('feat/code'), before);
    assert.equal(existsSync(wt(3)), false);
});

test('--keep leaves the stopped merge in its worktree for a hand merge', () => {
    const r = sync(3, {}, '--keep');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /worktree is kept/);
    assert.equal(git(wt(3), 'diff', '--name-only', '--diff-filter=U'), 'src/app.ts');
    git(W, 'worktree', 'remove', '--force', wt(3));
});

test('a red words check stops it: nothing pushed', () => {
    const before = remoteHead('feat/bird');
    const r = sync(4, { SYNC_PR_WORDS_CHECK: 'echo "words:check — 1 problem(s)" >&2; exit 1' });
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /the words check is red on the merge/);
    assert.match(r.stderr, /1 problem\(s\)/);
    assert.equal(remoteHead('feat/bird'), before);
    assert.equal(existsSync(wt(4)), false);
});

test('a catalog git merged as text with a key written twice (no driver on that base): the check after the merge stops it', () => {
    git(W, 'checkout', '-q', '--detach', 'origin/feat/mieze');
    const plain = spawnSync('git', ['merge', '--no-edit', 'origin/release'], { cwd: W, env, encoding: 'utf8' });
    assert.equal(plain.status, 0, 'plain git merges the two catalogs without a conflict, so this tests the check');
    assert.equal(git(W, 'show', `HEAD:${DE}`).split('"Cat"').length - 1, 2, 'with "Cat" written twice');
    git(W, 'checkout', '-q', 'main');
    const before = remoteHead('feat/mieze');
    const r = sync(6);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /word catalogs fail the per-key check after the merge: .*"Cat" written twice/);
    assert.equal(remoteHead('feat/mieze'), before);
    assert.equal(existsSync(wt(6)), false);
});

test('--dry-run merges and checks but pushes nothing', () => {
    const before = remoteHead('feat/fox');
    const r = sync(5, {}, '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--dry-run: .* not pushed/);
    assert.match(r.stdout, /^head [0-9a-f]{40}$/m);
    assert.equal(remoteHead('feat/fox'), before);
});

test('a PR from a fork, or one not open, is refused before anything is touched', () => {
    let r = sync(9);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /comes from a fork/);
    pr(8, 'feat/fox', 'false', 'MERGED');
    r = sync(8);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /MERGED, not open/);
    r = sync(77);
    assert.equal(r.status, 2, 'gh knows no such PR');
});

// ── The driver on its own ─────────────────────────────────────────────────────────────────────────────────────────
function driver(file, b, ours, theirs, extraEnv = {}) {
    const d = mkdtempSync(path.join(T, 'drv-'));
    const [pb, po, pt] = ['base', 'ours', 'theirs'].map((n) => path.join(d, n));
    writeFileSync(pb, b); writeFileSync(po, ours); writeFileSync(pt, theirs);
    const e = { ...env, ...extraEnv };
    const r = spawnSync('node', [MERGER, '--driver', pb, po, pt, file], { cwd: d, env: e, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr, out: readFileSync(po, 'utf8') };
}
const B = catalog('base', '2026-11-01', BASE_WORDS);
const OURS = catalog('base; ours', '2026-11-01', { ...BASE_WORDS, Cat: 'Chat' });
const THEIRS = catalog('base; theirs', '2026-11-02', { ...BASE_WORDS, Dog: 'Chien' });

test('driver: keys both sides added are both kept, main (theirs by default) first', () => {
    const r = driver(CAT, B, OURS, THEIRS);
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.out);
    assert.deepEqual(Object.keys(o), ['_meta', 'Hello', 'Bye', 'Cat', 'Dog']);
    assert.equal(o._meta.draftedBy, 'base; theirs; ours');
    assert.equal(r.out, `${JSON.stringify(o, null, 2)}\n`);
});

test('driver: BEANPOOL_WORDS_MAIN=ours makes ours main (the train merging a PR into main)', () => {
    const r = driver(CAT, B, OURS, THEIRS, { BEANPOOL_WORDS_MAIN: 'ours' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.out)._meta.draftedBy, 'base; ours; theirs');
    assert.equal(driver(CAT, B, OURS, THEIRS, { BEANPOOL_WORDS_MAIN: 'sideways' }).status, 1, 'a wrong value is refused, not guessed');
});

test('driver: one key changed differently on each side leaves git\'s conflict markers and exits 1', () => {
    const r = driver(CAT, B, catalog('base', '2026-11-01', { ...BASE_WORDS, Hello: 'Salut' }), catalog('base', '2026-11-01', { ...BASE_WORDS, Hello: 'Coucou' }));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NOT merged per key: both sides changed "Hello"/);
    assert.match(r.out, /^<<<<<<< ours$/m);
    assert.match(r.out, /^>>>>>>> theirs$/m);
});

test('driver: a catalog both sides added (empty base) merges; text that is not JSON is left to git', () => {
    assert.equal(driver(CAT, '', OURS, THEIRS).status, 0);
    const r = driver(CAT, B, '{ not json\n', THEIRS);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NOT merged per key/);
});

test('driver: a file that is not a word catalog gets git\'s plain text merge', () => {
    const r = driver('apps/pwa/src/words.json', 'a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n');
    assert.equal(r.status, 0);
    assert.equal(r.out, 'A\nb\nC\n');
    assert.equal(driver('apps/pwa/src/x.txt', 'a\n', 'b\n', 'c\n').status, 1);
});

// ── The wiring in this repository ─────────────────────────────────────────────────────────────────────────────────
test('.gitattributes sends exactly the catalogs to the driver', () => {
    const attr = (f) => execFileSync('git', ['check-attr', 'merge', '--', f], { cwd: REPO, encoding: 'utf8' }).trim().split(': ').pop();
    for (const f of ['apps/pwa/words/fr.json', 'apps/native/words/zh-Hans.json', 'packages/beanpool-core/words/de.json']) assert.equal(attr(f), 'beanpool-words', f);
    for (const f of ['apps/pwa/src/fr.json', 'apps/pwa/words/sub/fr.json', 'apps/pwa/words/README.md', 'words/fr.json']) assert.equal(attr(f), 'unspecified', f);
});

test('lib.sh names the driver with the command the merger documents', () => {
    const line = 'node scripts/words-merge-3way.mjs --driver %O %A %B %P';
    assert.ok(readFileSync(path.join(HERE, 'lanes', 'lib.sh'), 'utf8').includes(`LANE_WORDS_DRIVER='${line}'`));
    assert.ok(readFileSync(MERGER, 'utf8').includes(line));
    assert.ok(readFileSync(path.join(REPO, '.gitattributes'), 'utf8').includes(line));
});

#!/usr/bin/env node
// The director's one command for publishing the members' guide and the operator manual after merging pull requests
// that changed their pages (Marty's decision, 2026-09-30; how versions work is in scripts/build.mjs). From anywhere in
// the repo:
//
//   pnpm guide:publish --merge    open a pull request off origin/main that writes the published copies, each
//                                 collection one version higher where its text changed, merge it (squash, admin) and
//                                 show that the merge landed
//   pnpm guide:publish            the same, but stop once the pull request is open
//   pnpm guide:publish --dry-run  show what would be published; push nothing
//   pnpm guide:publish --no-pr    push the branch; open no pull request (the tests use this)
//
// It never touches the checkout it is run from: it builds in a temporary worktree of origin/main and removes it after.
// Nothing to publish → it says so and exits 0, so it is safe to run after every merge. Should another guide change
// merge while its pull request is open, --merge closes it and publishes again from the new main.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REMOTE = 'origin';
const BASE = 'main';
const BUILD = 'packages/beanpool-guide/scripts/build.mjs';
/** What a publish writes. */
const PUBLISHED = ['packages/beanpool-guide/generated', 'apps/website/guide', 'apps/manager/public/images'];
/** What, changed on main meanwhile, makes an open publish stale: the pages, the build and its outputs. */
const GUIDE = ['packages/beanpool-guide', ...PUBLISHED];
const FLAGS = ['--merge', '--dry-run', '--no-pr'];

const args = process.argv.slice(2);
if (args.some(a => !FLAGS.includes(a)) || (args.includes('--dry-run') && args.length > 1) || (args.includes('--merge') && args.includes('--no-pr'))) {
    console.error('Usage: pnpm guide:publish [--merge | --dry-run | --no-pr]');
    process.exit(2);
}
const merge = args.includes('--merge');
const dryRun = args.includes('--dry-run');
const noPr = args.includes('--no-pr');

function run(cmd, cmdArgs, cwd, { quiet = false } = {}) {
    try {
        return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] }).trim();
    } catch (e) {
        const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`${cmd} ${cmdArgs.join(' ')} failed${out ? `:\n${out}` : ''}`);
    }
}
const tryRun = (cmd, cmdArgs, cwd) => { try { return run(cmd, cmdArgs, cwd, { quiet: true }); } catch { return null; } };

const repo = run('git', ['rev-parse', '--show-toplevel'], process.cwd());
const version = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, 'packages/beanpool-guide/generated', file), 'utf8')).version;

/** One attempt from the current origin/main. Returns 'done', or 'again' when main changed the guide meanwhile. */
function attempt() {
    run('git', ['fetch', '-q', REMOTE, BASE], repo);
    const base = run('git', ['rev-parse', `${REMOTE}/${BASE}`], repo);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-publish-'));
    const dir = path.join(scratch, 'worktree');
    let branch = null;
    run('git', ['worktree', 'add', '-q', '--detach', dir, base], repo);
    try {
        const before = { guide: version(dir, 'guide.json'), manual: version(dir, 'operators.json') };
        const built = run(process.execPath, [BUILD, '--publish'], dir);
        if (!run('git', ['status', '--porcelain', '--', ...PUBLISHED], dir)) {
            console.log(`Nothing to publish: ${REMOTE}/${BASE} (${base.slice(0, 10)}) has published every page — members' guide v${before.guide}, operator manual v${before.manual}.`);
            return 'done';
        }
        const after = { guide: version(dir, 'guide.json'), manual: version(dir, 'operators.json') };
        const changes = [
            after.guide !== before.guide ? `members' guide v${before.guide} → v${after.guide}` : null,
            after.manual !== before.manual ? `operator manual v${before.manual} → v${after.manual}` : null,
        ].filter(Boolean);
        const title = `Publish the guide: ${changes.join(', ') || 'regenerated files'}`;
        branch = `guide/publish-members-v${after.guide}-manual-v${after.manual}`;
        run('git', ['switch', '-q', '-c', branch], dir);
        run('git', ['add', '--', ...PUBLISHED], dir);
        run('git', ['commit', '-q', '-m', title, '-m',
            `Written by pnpm guide:publish from ${REMOTE}/${BASE} at ${base.slice(0, 10)}: the text of the pages that merged since the last publish.`], dir);
        // The same check CI runs, against origin/main: a publish-only change, one version up, the pages' own text.
        run(process.execPath, [BUILD, '--check'], dir);
        console.log(`${built}\n${run('git', ['show', '--stat', '--format=%s', 'HEAD'], dir)}`);
        if (dryRun) {
            console.log('Dry run: nothing pushed.');
            return 'done';
        }
        run('git', ['push', '-q', REMOTE, `${branch}:${branch}`], dir);
        console.log(`Pushed ${branch}`);
        if (noPr) return 'done';

        const body = [
            `Publishes the guide text that merged into ${BASE} since the last publish: ${changes.join(', ')}.`,
            '',
            `Written by \`pnpm guide:publish\` from ${REMOTE}/${BASE} at ${base.slice(0, 10)}; it changes only the published copies`,
            `(${PUBLISHED.join(', ')}). The pages merged in their own PRs; see packages/beanpool-guide/README.md.`,
        ].join('\n');
        const url = run('gh', ['pr', 'create', '--base', BASE, '--head', branch, '--title', title, '--body', body], dir).split('\n').pop();
        console.log(url);
        if (!merge) {
            console.log(`Merge it before another guide change merges: gh pr merge ${url} --squash --admin`);
            return 'done';
        }
        run('git', ['fetch', '-q', REMOTE, BASE], repo);
        const tip = run('git', ['rev-parse', `${REMOTE}/${BASE}`], repo);
        if (tip !== base && run('git', ['diff', '--name-only', base, tip, '--', ...GUIDE], repo)) {
            console.log(`${BASE} changed the guide while this was open; closing it and publishing again from the new ${BASE}.`);
            run('gh', ['pr', 'close', url, '--comment', `Superseded: ${BASE} changed the guide before this merged.`], dir);
            tryRun('git', ['push', '-q', REMOTE, '--delete', branch], dir);
            return 'again';
        }
        run('gh', ['pr', 'merge', url, '--squash', '--admin'], dir);
        run('git', ['fetch', '-q', REMOTE, BASE], repo);
        const landed = run('git', ['diff', '--stat', tip, `${REMOTE}/${BASE}`, '--', ...PUBLISHED], repo);
        if (!landed) throw new Error(`${url} reports merged, but ${REMOTE}/${BASE} does not carry its files`);
        console.log(`Merged. ${REMOTE}/${BASE} now carries:\n${landed}`);
        tryRun('git', ['push', '-q', REMOTE, '--delete', branch], dir);
        return 'done';
    } finally {
        tryRun('git', ['worktree', 'remove', '--force', dir], repo);
        fs.rmSync(scratch, { recursive: true, force: true });
        tryRun('git', ['worktree', 'prune'], repo);
        if (branch) tryRun('git', ['branch', '-D', branch], repo);
    }
}

try {
    for (let i = 0; i < 3; i++) {
        if (attempt() === 'done') process.exit(0);
    }
    console.error(`${BASE} kept changing the guide; run pnpm guide:publish --merge again.`);
    process.exit(1);
} catch (e) {
    console.error(e.message);
    process.exit(1);
}

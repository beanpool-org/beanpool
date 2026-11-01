#!/usr/bin/env node
// The director's one command for publishing the members' guide and the operator manual after merging pull requests
// that changed their pages (Marty's decision, 2026-09-30; how versions work is in scripts/build.mjs). From anywhere in
// the repo:
//
//   pnpm guide:publish --merge    open a pull request off origin/main that writes the published copies, each
//                                 collection one version higher where its text changed, send it through the merge
//                                 queue (scripts/merge-queue/board.sh, which waits for it) and show that the merge landed
//   pnpm guide:publish            the same, but stop once the pull request is open
//   pnpm guide:publish --dry-run  show what would be published; push nothing
//   pnpm guide:publish --no-pr    push the branch; open no pull request (the tests use this)
//
// It never touches the checkout it is run from: it builds in a temporary worktree of origin/main and removes it after.
// Nothing to publish → it says so and exits 0, so it is safe to run after every merge. Should another guide change
// merge while its pull request is open, --merge closes it and publishes again from the new main. Should it stop for any
// other reason, running it again replaces the pull request and branch it left.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GUIDE_LANGS } from '../src/guide.mjs';

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
        // maxBuffer: a published copy can pass execFileSync's default 1 MiB (see build.mjs's git()).
        return execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
    } catch (e) {
        const out = [e.stdout, e.stderr].filter(Boolean).join('\n').trim();
        throw new Error(`${cmd} ${cmdArgs.join(' ')} failed${out ? `:\n${out}` : ''}`);
    }
}
const tryRun = (cmd, cmdArgs, cwd) => { try { return run(cmd, cmdArgs, cwd, { quiet: true }); } catch { return null; } };

const repo = run('git', ['rev-parse', '--show-toplevel'], process.cwd());
const version = (dir, file) => {
    const full = path.join(dir, 'packages/beanpool-guide/generated', file);
    return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, 'utf8')).version : null;
};

/** origin/main now, and whether it has changed the guide since `commit`. */
function mainSince(commit) {
    run('git', ['fetch', '-q', REMOTE, BASE], repo);
    const tip = run('git', ['rev-parse', `${REMOTE}/${BASE}`], repo);
    return { tip, guideChanged: tip !== commit && run('git', ['diff', '--name-only', commit, tip, '--', ...GUIDE], repo) !== '' };
}

/** Main changed the guide under this publish. Never fatal: the PR may be closed already, and deleting its branch closes it. */
function supersede(url, branch, dir) {
    console.log(`${BASE} changed the guide while this was open; closing it and publishing again from the new ${BASE}.`);
    tryRun('gh', ['pr', 'close', url, '--comment', `Superseded: ${BASE} changed the guide before this merged.`], dir);
    tryRun('git', ['push', '-q', REMOTE, '--delete', branch], dir);
}

/**
 * A publish that did not land leaves its branch on origin, and its pull request. Main never took them, so this publish works out
 * the same name and its push would be refused: close and delete them first, which is how running it again recovers.
 */
function clearLeftover(branch, dir) {
    if (!run('git', ['ls-remote', '--heads', REMOTE, `refs/heads/${branch}`], dir)) return;
    console.log(`Replacing ${branch}, left by a publish that did not land.`);
    const open = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[].url'], dir);
    for (const url of open.split('\n').filter(Boolean)) {
        run('gh', ['pr', 'close', url, '--comment', 'Superseded: a new publish replaces this one, which did not land.'], dir);
    }
    tryRun('git', ['push', '-q', REMOTE, '--delete', branch], dir);
}

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
        for (const lang of GUIDE_LANGS) {
            before[`guide:${lang}`] = version(dir, `guide.${lang}.json`);
        }
        const built = run(process.execPath, [BUILD, '--publish'], dir);
        if (!run('git', ['status', '--porcelain', '--', ...PUBLISHED], dir)) {
            console.log(`Nothing to publish: ${REMOTE}/${BASE} (${base.slice(0, 10)}) has published every page — members' guide v${before.guide}, operator manual v${before.manual}.`);
            return 'done';
        }
        const after = { guide: version(dir, 'guide.json'), manual: version(dir, 'operators.json') };
        for (const lang of GUIDE_LANGS) {
            after[`guide:${lang}`] = version(dir, `guide.${lang}.json`);
        }
        const changes = [
            after.guide !== before.guide ? `members' guide v${before.guide} → v${after.guide}` : null,
            after.manual !== before.manual ? `operator manual v${before.manual} → v${after.manual}` : null,
            ...GUIDE_LANGS.map(lang => {
                const b = before[`guide:${lang}`];
                const a = after[`guide:${lang}`];
                if (a === b) return null;
                return `${lang} guide v${b ?? 'none'} → v${a}`;
            }),
        ].filter(Boolean);
        const title = `Publish the guide: ${changes.join(', ') || 'regenerated files'}`;
        const langSuffix = GUIDE_LANGS.filter(l => after[`guide:${l}`] !== before[`guide:${l}`]).map(l => `-${l}-v${after[`guide:${l}`]}`).join('');
        branch = `guide/publish-members-v${after.guide}-manual-v${after.manual}${langSuffix}`;
        // -C and --ignore-other-worktrees: a run killed during the board's wait leaves this branch, in a worktree no finally removed.
        run('git', ['switch', '-q', '--ignore-other-worktrees', '-C', branch], dir);
        run('git', ['add', '--', ...PUBLISHED], dir);
        const websiteBuild = path.join(dir, 'scripts/website-build.mjs');
        if (fs.existsSync(websiteBuild)) {
            run(process.execPath, ['scripts/website-build.mjs'], dir);
            run('git', ['add', '--', 'apps/website'], dir);
        }
        run('git', ['commit', '-q', '-m', title, '-m',
            `Written by pnpm guide:publish from ${REMOTE}/${BASE} at ${base.slice(0, 10)}: the text of the pages that merged since the last publish.`], dir);
        // The same check CI runs, against origin/main: a publish-only change, one version up, the pages' own text.
        run(process.execPath, [BUILD, '--check'], dir);
        console.log(`${built}\n${run('git', ['show', '--stat', '--format=%s', 'HEAD'], dir)}`);
        if (dryRun) {
            console.log('Dry run: nothing pushed.');
            return 'done';
        }
        clearLeftover(branch, dir);
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
            console.log(`Merge it before another guide change merges: bash scripts/merge-queue/board.sh ${url}`);
            return 'done';
        }
        const { tip, guideChanged } = mainSince(base);
        if (guideChanged) {
            supersede(url, branch, dir);
            return 'again';
        }
        // From the temporary worktree: it is origin/main, and the checkout this was run from may be behind it.
        try {
            run('bash', ['scripts/merge-queue/board.sh', url], dir);
        } catch (e) {
            // The board waits for a PR run and a queue run, about 45 minutes, so a page edit can land after the check above.
            console.error(e.message);
            if (mainSince(tip).guideChanged) {
                supersede(url, branch, dir);
                return 'again';
            }
            throw new Error(`${url} did not land. Read the lines above; running pnpm guide:publish --merge again replaces it.`);
        }
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

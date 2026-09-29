// Guide versions on main (Marty's decision, 2026-09-30): pull requests change only the pages, and the director
// publishes after merging (scripts/publish.mjs), raising a collection's version by one where its text changed.
//
// These tests run the real build in a throwaway git repository — a copy of the guide package, the website's guide
// folder and the manager's copies of the manual's pictures, with a bare "origin" — and act out what happens on
// GitHub: PR branches off origin/main, merges on main, the director's publish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contentHash, renderWebsite, serializeGuide } from '../src/guide.mjs';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '../..');
const PKG = 'packages/beanpool-guide';
const GUIDE_JSON = `${PKG}/generated/guide.json`;
const MANUAL_JSON = `${PKG}/generated/operators.json`;
const WEBSITE = 'apps/website/guide';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const node = (cwd, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
const build = (cwd, ...args) => node(cwd, `${PKG}/scripts/build.mjs`, ...args);
/** The check as a GitHub Actions run of `event` (pull_request, push, workflow_dispatch) runs it. */
const ciCheck = (cwd, event) => spawnSync(process.execPath, [`${PKG}/scripts/build.mjs`, '--check'],
    { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event } });
const publishCommand = (cwd, ...args) => node(cwd, `${PKG}/scripts/publish.mjs`, ...args);
const read = (cwd, rel) => fs.readFileSync(path.join(cwd, rel), 'utf8');
const write = (cwd, rel, text) => fs.writeFileSync(path.join(cwd, rel), text);
const versions = cwd => ({ guide: JSON.parse(read(cwd, GUIDE_JSON)).version, manual: JSON.parse(read(cwd, MANUAL_JSON)).version });
const said = r => `exit ${r.status}\n${r.stdout}\n${r.stderr}`;

/** A throwaway repository holding what the guide build reads and writes, committed on main and pushed to a bare origin. */
function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-versions-'));
    const work = path.join(root, 'work');
    for (const rel of ['scripts', 'src', 'content', 'operators', 'generated', 'package.json']) {
        fs.cpSync(path.join(repoRoot, PKG, rel), path.join(work, PKG, rel), { recursive: true });
    }
    // The website's generated pages only: guide.test.mjs briefly plants a stray operators/ folder there.
    fs.mkdirSync(path.join(work, WEBSITE), { recursive: true });
    for (const f of fs.readdirSync(path.join(repoRoot, WEBSITE), { withFileTypes: true })) {
        if (f.isFile()) fs.copyFileSync(path.join(repoRoot, WEBSITE, f.name), path.join(work, WEBSITE, f.name));
    }
    const images = path.join(repoRoot, PKG, 'operators', 'images');
    fs.mkdirSync(path.join(work, 'apps/manager/public/images'), { recursive: true });
    for (const img of fs.readdirSync(images).filter(f => !f.startsWith('.'))) {
        fs.copyFileSync(path.join(repoRoot, 'apps/manager/public/images', img), path.join(work, 'apps/manager/public/images', img));
    }
    // The copy is this checkout's working tree. On a pull request that changes pages, their text waits to be published
    // (a PR never publishes; the director does, after merge), but these tests act out main as the director leaves it:
    // published. So what waits is published here, in the copy only, before the base commit. On a published main this
    // writes nothing.
    const published = build(work, '--publish');
    if (published.status !== 0) throw new Error(`the copied pages did not publish: ${published.stderr || published.stdout}`);
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 'guide-test@example.org');
    git(work, 'config', 'user.name', 'Guide test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    git(work, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(work, 'push', '-q', '-u', 'origin', 'main');
    return { root, work, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Add a paragraph to a page (a path under the guide package). */
function editPage(cwd, rel, text) {
    const file = path.join(cwd, PKG, rel);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + `\n${text}\n`);
}

/** Add a new page to a section: its file, and its slug on that section's "pages" line of the manifest (an edit of that line only). */
function addPage(cwd, collection, section, slug, related) {
    write(cwd, `${PKG}/${collection}/${section}/${slug}.md`,
        `---\nslug: ${slug}\ntitle: A page ${slug} adds\nsummary: Written on a branch.\nrelated: ${related}\n---\n\n${slug} wrote this page.\n`);
    const manifest = `${PKG}/${collection}/manifest.json`;
    const lines = read(cwd, manifest).split('\n');
    const at = lines.findIndex(l => l.includes(`"id": "${section}"`));
    const pages = lines.findIndex((l, i) => i > at && l.includes('"pages"'));
    lines[pages] = lines[pages].replace(/\]\s*$/, `, "${slug}"]`);
    write(cwd, manifest, lines.join('\n'));
}

/**
 * A pull request as an author makes one: a branch off origin/main, page edits, then the build every author runs
 * (it must succeed), then a commit of whatever that left changed. Returns the files the PR changed.
 */
function openPr(cwd, branch, edit) {
    git(cwd, 'fetch', '-q', 'origin');
    git(cwd, 'checkout', '-q', '-b', branch, 'origin/main');
    edit(cwd);
    const gen = build(cwd);
    assert.equal(gen.status, 0, `the author's build on ${branch}: ${said(gen)}`);
    const check = build(cwd, '--check');
    assert.equal(check.status, 0, `the check on ${branch}: ${said(check)}`);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', branch);
    git(cwd, 'push', '-q', 'origin', branch);
    return git(cwd, 'diff', '--name-only', 'origin/main', 'HEAD').split('\n').sort();
}

/** GitHub merging a pull request into main. Returns the conflicted files, or [] when it merged. */
function mergeOnMain(cwd, branch) {
    git(cwd, 'checkout', '-q', 'main');
    git(cwd, 'merge', '-q', '--ff-only', 'origin/main');
    const r = spawnSync('git', ['merge', '--no-ff', '-q', '-m', `Merge ${branch}`, `origin/${branch}`], { cwd, encoding: 'utf8' });
    if (r.status !== 0) {
        const conflicted = git(cwd, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        git(cwd, 'merge', '--abort');
        return conflicted.length ? conflicted : [`(merge failed: ${r.stderr})`];
    }
    git(cwd, 'push', '-q', 'origin', 'main');
    return [];
}

/** The director's publish: the one command pushes a branch off origin/main, and it is merged. Returns its branch, or null. */
function publishAndMerge(cwd) {
    const r = publishCommand(cwd, '--no-pr');
    assert.equal(r.status, 0, `publish: ${said(r)}`);
    const branch = /Pushed (\S+)/.exec(r.stdout)?.[1] ?? null;
    if (!branch) return null;
    git(cwd, 'fetch', '-q', 'origin');
    assert.deepEqual(mergeOnMain(cwd, branch), []);
    return branch;
}

const PR = {
    a: cwd => {
        editPage(cwd, 'content/ledger/gifts.md', 'Branch a changed this page.');
        editPage(cwd, 'operators/server/rate-limits.md', 'Branch a changed this manual page.');
        addPage(cwd, 'content', 'map', 'branch-a-page', 'near-you');
    },
    b: cwd => {
        editPage(cwd, 'content/map/near-you.md', 'Branch b changed this page.');
        editPage(cwd, 'operators/help/troubleshooting.md', 'Branch b changed this manual page.');
        addPage(cwd, 'content', 'ledger', 'branch-b-page', 'gifts');
    },
};
const PR_FILES = {
    a: [`${PKG}/content/ledger/gifts.md`, `${PKG}/operators/server/rate-limits.md`, `${PKG}/content/map/branch-a-page.md`, `${PKG}/content/manifest.json`].sort(),
    b: [`${PKG}/content/map/near-you.md`, `${PKG}/operators/help/troubleshooting.md`, `${PKG}/content/ledger/branch-b-page.md`, `${PKG}/content/manifest.json`].sort(),
};

for (const order of [['a', 'b'], ['b', 'a']]) {
    test(`two PRs that change guide text merge in either order (${order.join(' then ')}) with no conflict, and each publish raises both versions`, () => {
        const repo = makeRepo();
        try {
            const cwd = repo.work;
            const start = versions(cwd);
            // Each PR touches only its pages (and the manifest line of the section it adds to): the author's build
            // writes no version and no generated file.
            assert.deepEqual(openPr(cwd, 'a', PR.a), PR_FILES.a);
            assert.deepEqual(openPr(cwd, 'b', PR.b), PR_FILES.b);

            let before = start;
            for (const branch of order) {
                assert.deepEqual(mergeOnMain(cwd, branch), [], `merging ${branch} conflicts`);
                // Between the merge and the publish, main still holds the last published copy: the old text under
                // the old version, which is what any build from main ships.
                assert.deepEqual(versions(cwd), before);
                const pending = build(cwd, '--check');
                assert.equal(pending.status, 0, said(pending));
                assert.match(pending.stdout, /wait(s|ing)? to be published/);

                assert.ok(publishAndMerge(cwd), 'there was text to publish');
                const now = versions(cwd);
                assert.ok(now.guide > before.guide, `members' guide v${now.guide} after v${before.guide}`);
                assert.ok(now.manual > before.manual, `operator manual v${now.manual} after v${before.manual}`);
                const onMain = build(cwd, '--check');
                assert.equal(onMain.status, 0, said(onMain));
                before = now;
            }
            assert.deepEqual(before, { guide: start.guide + 2, manual: start.manual + 2 });
            // What main publishes last is both PRs' text, on the website and in the apps' bundle alike.
            const guide = read(cwd, GUIDE_JSON);
            for (const words of ['Branch a changed this page.', 'Branch b changed this page.', 'branch-a-page wrote this page.', 'branch-b-page wrote this page.']) {
                assert.ok(guide.includes(words), words);
            }
            assert.equal(read(cwd, `${WEBSITE}/guide.json`), guide);
            assert.ok(read(cwd, MANUAL_JSON).includes('Branch b changed this manual page.'));
            assert.ok(fs.existsSync(path.join(cwd, WEBSITE, 'branch-b-page.html')));
            // Nothing is left to publish.
            assert.equal(build(cwd, '--pending').status, 0);
            assert.equal(publishAndMerge(cwd), null);
        } finally {
            repo.cleanup();
        }
    });
}

test('two PRs merged before one publish: that publish raises each version by one, above what main had before either', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const start = versions(cwd);
        openPr(cwd, 'a', PR.a);
        openPr(cwd, 'b', PR.b);
        assert.deepEqual(mergeOnMain(cwd, 'b'), []);
        assert.deepEqual(mergeOnMain(cwd, 'a'), []);
        assert.equal(build(cwd, '--pending').status, 1, 'the text of both waits to be published');
        publishAndMerge(cwd);
        assert.deepEqual(versions(cwd), { guide: start.guide + 1, manual: start.manual + 1 });
        const guide = read(cwd, GUIDE_JSON);
        assert.ok(guide.includes('Branch a changed this page.') && guide.includes('Branch b changed this page.'));
    } finally {
        repo.cleanup();
    }
});

test('publishing: changed text goes out one version higher; publishing again with no new text changes nothing', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const start = versions(cwd);
        editPage(cwd, 'content/ledger/gifts.md', 'New words.');
        const first = build(cwd, '--publish');
        assert.equal(first.status, 0, said(first));
        assert.deepEqual(versions(cwd), { guide: start.guide + 1, manual: start.manual }, 'only the collection whose text changed');
        const after = git(cwd, 'status', '--porcelain');
        const again = build(cwd, '--publish');
        assert.equal(again.status, 0, said(again));
        assert.deepEqual(versions(cwd), { guide: start.guide + 1, manual: start.manual });
        assert.equal(git(cwd, 'status', '--porcelain'), after, 'the same text never gets a second version');
    } finally {
        repo.cleanup();
    }
});

// ─── What the check refuses ────────────────────────────────────────────────────

/** A branch off origin/main whose change is `edit`, committed; returns the check's result. */
function checkBranch(cwd, branch, edit) {
    git(cwd, 'checkout', '-q', '-b', branch, 'origin/main');
    edit(cwd);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', branch);
    const r = build(cwd, '--check');
    git(cwd, 'checkout', '-q', 'main');
    return r;
}

/** Rewrite the published members' guide by hand, keeping it self-consistent (its hash and website pages match it). */
function handPublish(cwd, change) {
    const guide = JSON.parse(read(cwd, GUIDE_JSON));
    change(guide);
    guide.hash = contentHash({ sections: guide.sections, guides: guide.guides });
    write(cwd, GUIDE_JSON, serializeGuide(guide));
    for (const [name, text] of Object.entries(renderWebsite(guide))) write(cwd, `${WEBSITE}/${name}`, text);
}
const changeText = g => { g.guides[0].blocks[0] = { type: 'p', text: 'Words that no page says.' }; };

test('the check refuses changed text under an old version', () => {
    const repo = makeRepo();
    try {
        const r = checkBranch(repo.work, 'same-version', cwd => handPublish(cwd, changeText));
        assert.equal(r.status, 1, said(r));
        assert.match(r.stderr, /members' guide.*text changed.*v\d+, not above/);
    } finally {
        repo.cleanup();
    }
});

test('the check refuses the same text under a new version, and a version that goes down', () => {
    const repo = makeRepo();
    try {
        const up = checkBranch(repo.work, 'same-text', cwd => handPublish(cwd, g => { g.version += 1; }));
        assert.equal(up.status, 1, said(up));
        assert.match(up.stderr, /same text .* under v\d+/);
        const down = checkBranch(repo.work, 'down', cwd => handPublish(cwd, g => { changeText(g); g.version -= 1; }));
        assert.equal(down.status, 1, said(down));
        assert.match(down.stderr, /not above/);
    } finally {
        repo.cleanup();
    }
});

test('the check refuses a PR that edits pages and publishes them itself (the old way, which made PRs conflict)', () => {
    const repo = makeRepo();
    try {
        const r = checkBranch(repo.work, 'self-publish', cwd => {
            editPage(cwd, 'content/ledger/gifts.md', 'New words.');
            assert.equal(build(cwd, '--publish').status, 0);
        });
        assert.equal(r.status, 1, said(r));
        assert.match(r.stderr, /edits the members' guide's pages .* AND publishes them/);
        assert.match(r.stderr, /git checkout \S+ -- packages\/beanpool-guide\/generated apps\/website\/guide/);
    } finally {
        repo.cleanup();
    }
});

test('the check refuses a published copy that is not the text of the pages, or that skips a version', () => {
    const repo = makeRepo();
    try {
        const made = checkBranch(repo.work, 'made-up', cwd => handPublish(cwd, g => { changeText(g); g.version += 1; }));
        assert.equal(made.status, 1, said(made));
        assert.match(made.stderr, /is not the text of the pages/);
        const skip = checkBranch(repo.work, 'skip', cwd => {
            editPage(cwd, 'content/ledger/gifts.md', 'New words.');
            git(cwd, 'add', '-A');
            git(cwd, 'commit', '-q', '-m', 'pages');
            git(cwd, 'push', '-q', 'origin', 'HEAD:main');
            git(cwd, 'fetch', '-q', 'origin');
            assert.equal(build(cwd, '--publish').status, 0);
            handPublish(cwd, g => { g.version += 1; });
        });
        assert.equal(skip.status, 1, said(skip));
        assert.match(skip.stderr, /jumps from v\d+ to v\d+/);
    } finally {
        repo.cleanup();
    }
});

test('the check refuses uncommitted hand edits too, compared with the commit under them', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        handPublish(cwd, changeText);
        const r = build(cwd, '--check');
        assert.equal(r.status, 1, said(r));
        assert.match(r.stderr, /not above/);
    } finally {
        repo.cleanup();
    }
});

test('the check still catches a hand-edited or stray generated file, a stale picture and a manifest "version"', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const cases = [
            [`${WEBSITE}/gifts.html`, t => t.replace('</main>', '<p>hand edit</p></main>'), /gifts\.html does not match/],
            [GUIDE_JSON, t => t.replace(/"text": "[^"]*"/, '"text": "hand edit"'), /edited by hand/],
            [`${PKG}/content/manifest.json`, t => t.replace('{', '{\n  "version": 89,'), /remove "version"/],
        ];
        for (const [rel, change, why] of cases) {
            const was = read(cwd, rel);
            write(cwd, rel, change(was));
            const r = build(cwd, '--check');
            write(cwd, rel, was);
            assert.equal(r.status, 1, `${rel}: ${said(r)}`);
            assert.match(r.stderr, why);
        }
        write(cwd, `${WEBSITE}/stray.html`, 'x');
        const stray = build(cwd, '--check');
        fs.rmSync(path.join(cwd, WEBSITE, 'stray.html'));
        assert.match(stray.stderr, /stray\.html is not generated/);
        const img = fs.readdirSync(path.join(cwd, 'apps/manager/public/images'))[0];
        write(cwd, `apps/manager/public/images/${img}`, 'stale');
        const stale = build(cwd, '--check');
        assert.match(stale.stderr, new RegExp(`${img.replace('.', '\\.')} is out of date`));
        assert.equal(build(cwd).status, 0, 'the author build copies it back');
        assert.equal(build(cwd, '--check').status, 0);
    } finally {
        repo.cleanup();
    }
});

test("in CI's checkout of a pull request — its merge commit, two commits deep, no origin/main — the check compares with main's tip", () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const mainTip = git(cwd, 'rev-parse', 'HEAD');
        // GitHub's refs/pull/N/merge: main's tip merged with the PR branch, main first.
        const mergeRef = (branch, edit) => {
            git(cwd, 'checkout', '-q', '-b', branch, 'origin/main');
            edit(cwd);
            git(cwd, 'add', '-A');
            git(cwd, 'commit', '-q', '-m', branch);
            git(cwd, 'checkout', '-q', '--detach', 'origin/main');
            git(cwd, 'merge', '--no-ff', '-q', '-m', `Merge ${branch} into main`, branch);
            const ref = `refs/pull/${branch}/merge`;
            git(cwd, 'push', '-q', 'origin', `HEAD:${ref}`);
            git(cwd, 'checkout', '-q', 'main');
            return ref;
        };
        // What actions/checkout does for a pull_request run.
        const ciCheckout = (ref, depth) => {
            const dir = fs.mkdtempSync(path.join(repo.root, 'ci-'));
            git(dir, 'init', '-q');
            git(dir, 'remote', 'add', 'origin', `file://${path.join(repo.root, 'origin.git')}`);
            git(dir, 'fetch', '-q', '--no-tags', `--depth=${depth}`, 'origin', `+${ref}:refs/remotes/pull/merge`);
            git(dir, 'checkout', '-q', '--detach', 'refs/remotes/pull/merge');
            return ciCheck(dir, 'pull_request');
        };

        const pagesOnly = mergeRef('pages', c => editPage(c, 'content/ledger/gifts.md', 'New words.'));
        const ok = ciCheckout(pagesOnly, 2);
        assert.equal(ok.status, 0, said(ok));
        assert.match(ok.stdout, new RegExp(`checked against ${mainTip.slice(0, 10)}`));

        const selfPublished = mergeRef('self', c => {
            editPage(c, 'content/ledger/gifts.md', 'New words.');
            assert.equal(build(c, '--publish').status, 0);
        });
        const refused = ciCheckout(selfPublished, 2);
        assert.equal(refused.status, 1, said(refused));
        assert.match(refused.stderr, /AND publishes them/);

        const shallow = ciCheckout(pagesOnly, 1);
        assert.equal(shallow.status, 1, said(shallow));
        assert.match(shallow.stderr, /fetch-depth: 2/);
    } finally {
        repo.cleanup();
    }
});

test('a branch whose tip merged origin/main, checked out with no origin/main outside a pull request (a workflow_dispatch run): versions not compared, never blamed for main\'s publish', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        // Branch x changes no guide file.
        git(cwd, 'checkout', '-q', '-b', 'x', 'origin/main');
        write(cwd, 'NOTE-x.txt', 'x\n');
        git(cwd, 'add', 'NOTE-x.txt');
        git(cwd, 'commit', '-q', '-m', 'x');
        git(cwd, 'push', '-q', 'origin', 'x');
        // Main gets a guide PR, then its publish.
        git(cwd, 'checkout', '-q', 'main');
        editPage(cwd, 'content/ledger/gifts.md', 'Main changed this page.');
        git(cwd, 'commit', '-q', '-am', 'a guide PR');
        assert.equal(build(cwd, '--publish').status, 0);
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-q', '-m', 'publish');
        git(cwd, 'push', '-q', 'origin', 'main');
        // x syncs with main: its tip is a merge whose first parent is x before the sync, not main.
        git(cwd, 'checkout', '-q', 'x');
        git(cwd, 'fetch', '-q', 'origin');
        git(cwd, 'merge', '--no-ff', '-q', '-m', 'Merge origin/main into x', 'origin/main');
        git(cwd, 'push', '-q', 'origin', 'x');
        // What actions/checkout does for a workflow_dispatch run on x: refs/heads/x, two commits deep, no origin/main.
        const dir = fs.mkdtempSync(path.join(repo.root, 'ci-'));
        git(dir, 'init', '-q');
        git(dir, 'remote', 'add', 'origin', `file://${path.join(repo.root, 'origin.git')}`);
        git(dir, 'fetch', '-q', '--no-tags', '--depth=2', 'origin', '+refs/heads/x:refs/remotes/origin/x');
        git(dir, 'checkout', '-q', '-B', 'x', 'refs/remotes/origin/x');
        for (const event of ['workflow_dispatch', 'push']) {
            const r = ciCheck(dir, event);
            assert.equal(r.status, 0, `${event}: ${said(r)}`);
            assert.match(r.stdout, /Versions not compared: no origin\/main/);
        }
        // With origin/main, it is compared, and passes: x publishes nothing.
        git(dir, 'fetch', '-q', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
        const compared = ciCheck(dir, 'workflow_dispatch');
        assert.equal(compared.status, 0, said(compared));
        assert.match(compared.stdout, /checked against .*where this branch left origin\/main/);
    } finally {
        repo.cleanup();
    }
});

// ─── The director's one command ───────────────────────────────────────────────

test("the director's publish command: nothing to do on a published main; otherwise one branch off origin/main holding only the published files", () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const nothing = publishCommand(cwd, '--no-pr');
        assert.equal(nothing.status, 0, said(nothing));
        assert.match(nothing.stdout, /Nothing to publish/);

        const start = versions(cwd);
        editPage(cwd, 'content/ledger/gifts.md', 'Words on main.');
        git(cwd, 'commit', '-q', '-am', 'a PR merged');
        git(cwd, 'push', '-q', 'origin', 'main');
        // A checkout that is behind and dirty is never touched: the command works from origin/main in its own worktree.
        git(cwd, 'checkout', '-q', 'HEAD~1');
        write(cwd, `${PKG}/content/ledger/gifts.md`, 'an uncommitted scribble');
        const dry = publishCommand(cwd, '--dry-run');
        assert.equal(dry.status, 0, said(dry));
        assert.match(dry.stdout, /members' guide v\d+ → v\d+/);
        assert.equal(git(cwd, 'ls-remote', '--heads', 'origin', 'guide/*'), '', 'a dry run pushes nothing');

        const r = publishCommand(cwd, '--no-pr');
        assert.equal(r.status, 0, said(r));
        assert.equal(read(cwd, `${PKG}/content/ledger/gifts.md`), 'an uncommitted scribble');
        const branch = /Pushed (\S+)/.exec(r.stdout)[1];
        assert.equal(branch, `guide/publish-members-v${start.guide + 1}-manual-v${start.manual}`);
        git(cwd, 'fetch', '-q', 'origin');
        const files = git(cwd, 'diff', '--name-only', 'origin/main', `origin/${branch}`).split('\n');
        assert.ok(files.length > 1);
        for (const f of files) assert.match(f, /^(packages\/beanpool-guide\/generated|apps\/website\/guide)\//, f);
        assert.equal(git(cwd, 'rev-parse', `origin/${branch}~1`), git(cwd, 'rev-parse', 'origin/main'), 'one commit on top of origin/main');
        assert.equal(git(cwd, 'worktree', 'list').split('\n').length, 1, 'its worktree is gone');
        assert.equal(git(cwd, 'branch', '--list', 'guide/*'), '', 'and so is its local branch');
    } finally {
        repo.cleanup();
    }
});

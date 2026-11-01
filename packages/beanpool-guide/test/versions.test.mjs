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
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contentHash, renderWebsite, serializeGuide, guideBodyHash } from '../src/guide.mjs';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '../..');
const PKG = 'packages/beanpool-guide';
const GUIDE_JSON = `${PKG}/generated/guide.json`;
const MANUAL_JSON = `${PKG}/generated/operators.json`;
const WEBSITE = 'apps/website/guide';

// `git commit`/`fetch`/`push` can start a detached `gc --auto`/maintenance that is still writing into .git/objects when the
// test removes the folder (ENOTEMPTY). Switch it off for every git this file spawns, including the ones build.mjs runs.
Object.assign(process.env, {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'gc.auto', GIT_CONFIG_VALUE_0: '0',
    GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'core.fsmonitor', GIT_CONFIG_VALUE_2: 'false',
});
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const node = (cwd, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: undefined } });
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
/**
 * A published copy of the guide package in a scratch git repository. `withoutPages` names languages whose translated pages
 * (content/<lang>/<section>/) and published copy (generated/guide.<lang>.json) are left out of the copy, so a test can add a language's first page as it would be on day one
 * whatever pages main holds by then (its titles file, content/<lang>/manifest.json, stays).
 */
function makeRepo({ withoutPages = [] } = {}) {
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
    for (const lang of withoutPages) {
        const dir = path.join(work, PKG, 'content', lang);
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) fs.rmSync(path.join(dir, e.name), { recursive: true });
        // and its published copy, once main has published that language (the website's <lang>/ folder is not copied)
        fs.rmSync(path.join(work, PKG, 'generated', `guide.${lang}.json`), { force: true });
    }
    const images = path.join(repoRoot, PKG, 'operators', 'images');
    fs.mkdirSync(path.join(work, 'apps/manager/public/images'), { recursive: true });
    for (const img of fs.readdirSync(images).filter(f => !f.startsWith('.'))) {
        fs.copyFileSync(path.join(repoRoot, 'apps/manager/public/images', img), path.join(work, 'apps/manager/public/images', img));
    }
    // Every test starts from a published main: nothing waits to be published. The working tree this copies may hold
    // text that does (a PR's page edits, or main between a merge and the director's publish), so publish it here, in
    // the copy, before the first commit. With nothing waiting this writes the same files and changes nothing.
    const seeded = build(work, '--publish');
    assert.equal(seeded.status, 0, `publishing the copy's pages: ${said(seeded)}`);
    const waiting = build(work, '--pending');
    assert.equal(waiting.status, 0, `the copy starts with nothing to publish: ${said(waiting)}`);
    git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'config', 'user.email', 'guide-test@example.org');
    git(work, 'config', 'user.name', 'Guide test');
    git(work, 'config', 'commit.gpgsign', 'false');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    git(work, 'remote', 'add', 'origin', path.join(root, 'origin.git'));
    git(work, 'push', '-q', '-u', 'origin', 'main');
    return { root, work, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
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

// This suite runs inside GitHub's own runs, and in the merge queue its event would send an author's build in a throwaway repo to
// the commit before HEAD: red on every queue entry, and on no pull request.
test('the run this suite is in does not reach the throwaway repos: only ciCheck names an event', () => {
    const before = process.env.GITHUB_EVENT_NAME;
    process.env.GITHUB_EVENT_NAME = 'merge_group';
    try {
        assert.equal(node(process.cwd(), '-p', 'String(process.env.GITHUB_EVENT_NAME)').stdout.trim(), 'undefined');
    } finally {
        if (before === undefined) delete process.env.GITHUB_EVENT_NAME;
        else process.env.GITHUB_EVENT_NAME = before;
    }
});

test('a published copy over 1 MiB on main is still found: a PR that leaves it alone passes the check', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        // Tamil pages pass 1 MiB once a language has every page (3 bytes a letter); grow one page to get there today.
        editPage(cwd, 'content/ta/getting-started/communities.md', 'தமிழ் '.repeat(80_000));
        const pub = build(cwd, '--publish');
        assert.equal(pub.status, 0, said(pub));
        assert.ok(fs.statSync(path.join(cwd, PKG, 'generated/guide.ta.json')).size > 1024 * 1024, 'the Tamil copy is over 1 MiB');
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-q', '-m', 'publish a big Tamil guide');
        git(cwd, 'push', '-q', 'origin', 'main');
        openPr(cwd, 'english-edit', c => editPage(c, 'content/ledger/gifts.md', 'An English change.'));
    } finally {
        repo.cleanup();
    }
});

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

test('a merge queue entry is compared with what it lands on: a publish ahead of a page edit is not one change doing both', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        openPr(cwd, 'first', c => editPage(c, 'content/ledger/gifts.md', 'Words waiting for their publish.'));
        assert.deepEqual(mergeOnMain(cwd, 'first'), []);
        const main = git(cwd, 'rev-parse', 'origin/main');
        // The director's publish of those words, and a page edit, each a branch off main.
        git(cwd, 'checkout', '-q', '-b', 'publish', main);
        assert.equal(build(cwd, '--publish').status, 0);
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-q', '-m', 'publish');
        openPr(cwd, 'pages', c => editPage(c, 'content/ledger/gifts.md', 'Words a later PR adds.'));

        // The queue's branch: a squash commit on main for each PR, the one ahead first, and CI's checkout of it with origin/main fetched.
        const queued = (n, ...branches) => {
            git(cwd, 'checkout', '-q', '--detach', main);
            for (const b of branches) { git(cwd, 'merge', '-q', '--squash', b); git(cwd, 'commit', '-q', '-m', `squash ${b}`); }
            git(cwd, 'push', '-q', 'origin', `HEAD:refs/heads/gh-readonly-queue/main/pr-${n}-abc`);
            const tip = git(cwd, 'rev-parse', 'HEAD');
            git(cwd, 'checkout', '-q', 'main');
            const dir = fs.mkdtempSync(path.join(repo.root, 'queue-'));
            git(dir, 'init', '-q');
            git(dir, 'remote', 'add', 'origin', `file://${path.join(repo.root, 'origin.git')}`);
            git(dir, 'fetch', '-q', '--no-tags', '--depth=2', 'origin', `+refs/heads/gh-readonly-queue/main/pr-${n}-abc:refs/remotes/queue`);
            git(dir, 'checkout', '-q', '--detach', 'refs/remotes/queue');
            // As ci.yml's "Fetch origin/main": both ends 50 deep, the head by its sha (by a ref that is up to date, nothing deepens).
            git(path.join(repo.root, 'origin.git'), 'config', 'uploadpack.allowAnySHA1InWant', 'true');
            git(dir, 'fetch', '-q', '--no-tags', '--depth=50', 'origin', '+refs/heads/main:refs/remotes/origin/main', tip);
            assert.equal(git(dir, 'merge-base', 'HEAD', 'origin/main'), main, 'the step gives a merge base: main under every entry');
            return { dir, parent: git(dir, 'rev-parse', 'HEAD^1') };
        };

        const behindPublish = queued(2, 'publish', 'pages');
        const ok = ciCheck(behindPublish.dir, 'merge_group');
        assert.equal(ok.status, 0, said(ok));
        assert.match(ok.stdout, new RegExp(`checked against ${behindPublish.parent.slice(0, 10)}`));
        const asIfOneChange = ciCheck(behindPublish.dir, 'pull_request');
        assert.equal(asIfOneChange.status, 1, 'compared with main under both, the two PRs read as one change');
        assert.match(asIfOneChange.stderr, /AND publishes them/);

        // The other way round the publish is stale: its text is not the pages' now. That red is right: publish again.
        const staleBehindPages = ciCheck(queued(3, 'pages', 'publish').dir, 'merge_group');
        assert.equal(staleBehindPages.status, 1, said(staleBehindPages));
        assert.match(staleBehindPages.stderr, /is not the text of the pages/);
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
            // The line test-all.sh reports a skip by: passing, this check compared nothing, and must not read as a pass.
            assert.match(r.stdout, /^⚪ SKIP: /m);
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

// ─── A publish that does not land ─────────────────────────────────────────────

/** Fetch origin and move the checkout to main's tip. */
function onMain(cwd) {
    git(cwd, 'checkout', '-q', 'main');
    git(cwd, 'fetch', '-q', 'origin');
    git(cwd, 'merge', '-q', '--ff-only', 'origin/main');
}

/** A page edit merging on main. */
function pageOnMain(cwd, words) {
    onMain(cwd);
    editPage(cwd, 'content/ledger/gifts.md', words);
    git(cwd, 'commit', '-q', '-am', 'a page edit');
    git(cwd, 'push', '-q', 'origin', 'main');
}

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FAKE_GH_STATE;
const prs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const a = process.argv.slice(2);
const after = x => a[a.indexOf(x) + 1];
if (a[0] === 'pr' && a[1] === 'create') {
    prs.push({ url: 'https://github.com/x/y/pull/' + (prs.length + 1), head: after('--head'), state: 'OPEN' });
    fs.writeFileSync(file, JSON.stringify(prs));
    fs.writeFileSync(file + '.head', after('--head'));
    console.log(prs.at(-1).url);
} else if (a[0] === 'pr' && a[1] === 'list') {
    console.log(prs.filter(p => p.head === after('--head') && p.state === 'OPEN').map(p => p.url).join('\\n'));
} else if (a[0] === 'pr' && a[1] === 'close') {
    prs.find(p => p.url === a[2]).state = 'CLOSED';
    fs.writeFileSync(file, JSON.stringify(prs));
} else {
    console.error('fake gh: no answer for ' + a.join(' '));
    process.exit(1);
}
`;

/** What a board does, one script a run. $SIDE is a clone of origin; the PR's branch is in $FAKE_GH_STATE.head. */
const BOARD = {
    /** The queue takes the PR out, with main as it was. */
    fails: 'echo "#1 NOT merged: taken out of the queue (state OPEN, run 77 failure)"; exit 1\n',
    /** A page edit lands during the wait, and the queue takes this publish, stale now, out. */
    editsPageAndFails: `git -C "$SIDE" fetch -q origin
git -C "$SIDE" checkout -q --detach origin/main
printf '\\nA page edit landed during the wait.\\n' >> "$SIDE/${PKG}/content/ledger/gifts.md"
git -C "$SIDE" commit -q -am 'a page edit'
git -C "$SIDE" push -q origin HEAD:main
echo "#1 NOT merged: taken out of the queue (state OPEN, run 78 failure)"; exit 1
`,
    /** The queue lands the PR on main. */
    lands: `git -C "$SIDE" fetch -q origin
git -C "$SIDE" checkout -q --detach origin/main
git -C "$SIDE" merge -q --no-ff -m 'land' "origin/$(cat "$FAKE_GH_STATE.head")"
git -C "$SIDE" push -q origin HEAD:main
echo "#1 MERGED"
`,
};

/**
 * GitHub around a publish: a gh on PATH that keeps pull requests in a file, and a board on the throwaway main, as publish runs the
 * one in origin/main, that acts out `boards` in turn. The test publishes with `publish` and reads what it left with `prs`.
 */
function queueStandIn(repo, boards = []) {
    const dir = path.join(repo.root, 'stand-in');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    boards.forEach((text, i) => fs.writeFileSync(path.join(dir, `board-${i + 1}.sh`), text));
    fs.mkdirSync(path.join(repo.work, 'scripts/merge-queue'), { recursive: true });
    write(repo.work, 'scripts/merge-queue/board.sh', `n=$(( $(cat "$STAND_IN/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STAND_IN/count"\n. "$STAND_IN/board-$n.sh"\n`);
    git(repo.work, 'add', 'scripts/merge-queue/board.sh');
    git(repo.work, 'commit', '-q', '-m', 'the board');
    git(repo.work, 'push', '-q', 'origin', 'main');
    const side = path.join(dir, 'side');
    git(repo.root, 'clone', '-q', 'origin.git', side);
    git(side, 'config', 'user.email', 'guide-test@example.org');
    git(side, 'config', 'user.name', 'Guide test');
    const state = path.join(dir, 'prs.json');
    return {
        publish: (...args) => spawnSync(process.execPath, [`${PKG}/scripts/publish.mjs`, ...args], {
            cwd: repo.work, encoding: 'utf8',
            env: { ...process.env, GITHUB_EVENT_NAME: undefined, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, STAND_IN: dir, SIDE: side },
        }),
        prs: () => JSON.parse(fs.readFileSync(state, 'utf8')).map(p => p.state),
    };
}

const branchOf = v => `guide/publish-members-v${v.guide + 1}-manual-v${v.manual}`;
const onOrigin = (cwd, branch) => git(cwd, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`) !== '';

test('a publish the queue did not land: publishing again, with a page edit in between, closes its PR, replaces its branch and lands', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const start = versions(cwd);
        const queue = queueStandIn(repo, [BOARD.fails, BOARD.lands]);
        pageOnMain(cwd, 'Words waiting for their publish.');

        const failed = queue.publish('--merge');
        assert.equal(failed.status, 1, said(failed));
        assert.match(failed.stderr, /#1 NOT merged: taken out of the queue/, "the board's reason reaches the reader");
        assert.match(failed.stderr, /github\.com\/x\/y\/pull\/1 did not land/);
        assert.ok(onOrigin(cwd, branchOf(start)), 'main did not change the guide, so its branch stays for the reader');
        assert.deepEqual(queue.prs(), ['OPEN']);

        pageOnMain(cwd, 'Words after the failed publish.');
        const again = queue.publish('--merge');
        assert.equal(again.status, 0, said(again));
        assert.match(again.stdout, /Replacing guide\/publish-members-v/);
        assert.match(again.stdout, /Merged\./);
        assert.deepEqual(queue.prs(), ['CLOSED', 'OPEN'], 'the old PR closed, and a new one on the same branch name');

        onMain(cwd);
        assert.deepEqual(versions(cwd), { guide: start.guide + 1, manual: start.manual }, 'one version up, not two');
        const guide = read(cwd, GUIDE_JSON);
        assert.ok(guide.includes('Words waiting for their publish.') && guide.includes('Words after the failed publish.'));
        assert.equal(build(cwd, '--pending').status, 0, 'nothing is left to publish');
    } finally {
        repo.cleanup();
    }
});

test('a page edit lands while the board waits and the queue takes the publish out: it closes that PR and publishes again from the new main', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const start = versions(cwd);
        const queue = queueStandIn(repo, [BOARD.editsPageAndFails, BOARD.lands]);
        pageOnMain(cwd, 'Words waiting for their publish.');

        const r = queue.publish('--merge');
        assert.equal(r.status, 0, said(r));
        assert.match(r.stdout, /main changed the guide while this was open/);
        assert.match(r.stdout, /Merged\./);
        assert.deepEqual(queue.prs(), ['CLOSED', 'OPEN']);

        onMain(cwd);
        assert.deepEqual(versions(cwd), { guide: start.guide + 1, manual: start.manual });
        assert.ok(read(cwd, GUIDE_JSON).includes('A page edit landed during the wait.'));
        assert.equal(build(cwd, '--pending').status, 0, 'nothing is left to publish');
    } finally {
        repo.cleanup();
    }
});

test('a pushed publish that never got a PR: publishing again replaces the branch', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const start = versions(cwd);
        const queue = queueStandIn(repo);
        pageOnMain(cwd, 'Words waiting for their publish.');
        const first = queue.publish('--no-pr');
        assert.equal(first.status, 0, said(first));

        pageOnMain(cwd, 'Words after the first push.');
        const again = queue.publish('--no-pr');
        assert.equal(again.status, 0, said(again));
        git(cwd, 'fetch', '-q', 'origin');
        const branch = branchOf(start);
        assert.equal(git(cwd, 'rev-parse', `origin/${branch}~1`), git(cwd, 'rev-parse', 'origin/main'), 'one commit on top of the new main');
        assert.match(git(cwd, 'show', `origin/${branch}:${GUIDE_JSON}`), /Words after the first push\./);
    } finally {
        repo.cleanup();
    }
});

test('a run killed during its wait leaves its branch in its temporary worktree: publishing again still works', () => {
    const repo = makeRepo();
    try {
        const cwd = repo.work;
        const start = versions(cwd);
        const queue = queueStandIn(repo, [BOARD.lands]);
        pageOnMain(cwd, 'Words waiting for their publish.');
        // No finally runs on a kill: the branch stays checked out in a folder that is still there, and on origin.
        const branch = branchOf(start);
        git(cwd, 'worktree', 'add', '-q', '-b', branch, path.join(repo.root, 'killed'), 'origin/main');
        git(cwd, 'push', '-q', 'origin', `${branch}:${branch}`);

        const r = queue.publish('--merge');
        assert.equal(r.status, 0, said(r));
        assert.match(r.stdout, /Merged\./);
    } finally {
        repo.cleanup();
    }
});

test('version isolation: a language publish raises that language version and leaves English untouched', () => {
    const repo = makeRepo({ withoutPages: ['ru'] });
    try {
        const cwd = repo.work;
        const enBefore = versions(cwd);
        const enJsonBefore = read(cwd, GUIDE_JSON);
        const enGuide = JSON.parse(enJsonBefore);
        const homePage = enGuide.guides.find(g => g.slug === 'home');
        const homeHash = guideBodyHash(homePage);

        // Add a translated page for Russian
        const ruDir = path.join(cwd, PKG, 'content/ru/getting-started');
        fs.mkdirSync(ruDir, { recursive: true });
        const page = [
            '---',
            'slug: home',
            'title: Главная',
            'summary: Описание.',
            'related: rules',
            `source-hash: ${homeHash}`,
            '---',
            '',
            'Текст на русском.',
        ].join('\n');
        write(cwd, `${PKG}/content/ru/getting-started/home.md`, page);
        git(cwd, 'add', `${PKG}/content/ru/getting-started/home.md`);
        git(cwd, 'commit', '-q', '-m', 'add ru home page');
        git(cwd, 'push', '-q', 'origin', 'main');

        // Publish
        const pub = publishCommand(cwd, '--no-pr');
        assert.equal(pub.status, 0, said(pub));
        assert.match(pub.stdout, /ru guide vnone → v1/);

        // Check English is completely untouched
        git(cwd, 'fetch', '-q', 'origin');
        const branch = /Pushed (\S+)/.exec(pub.stdout)[1];
        assert.equal(branch, `guide/publish-members-v${enBefore.guide}-manual-v${enBefore.manual}-ru-v1`);

        const diffFiles = git(cwd, 'diff', '--name-only', 'origin/main', `origin/${branch}`).split('\n');
        assert.ok(diffFiles.includes('packages/beanpool-guide/generated/guide.ru.json'));
        assert.ok(diffFiles.includes('apps/website/guide/ru/guide.json'));
        assert.ok(diffFiles.includes('apps/website/guide/ru/home.html'));
        assert.ok(!diffFiles.includes('packages/beanpool-guide/generated/guide.json'), 'English guide.json untouched');
        assert.ok(!diffFiles.includes('apps/website/guide/guide.json'), 'English website guide.json untouched');

        // Publishing again without changes does nothing
        git(cwd, 'merge', '-q', `origin/${branch}`);
        git(cwd, 'push', '-q', 'origin', 'main');
        const pub2 = publishCommand(cwd, '--no-pr');
        assert.equal(pub2.status, 0, said(pub2));
        assert.match(pub2.stdout, /Nothing to publish/);
    } finally {
        repo.cleanup();
    }
});

test('the check refuses a PR that introduces a new language guide and publishes it itself', () => {
    const repo = makeRepo({ withoutPages: ['ru'] });
    try {
        const cwd = repo.work;
        git(cwd, 'checkout', '-q', '-b', 'add-ru-guide');

        const enJson = read(cwd, GUIDE_JSON);
        const enGuide = JSON.parse(enJson);
        const homePage = enGuide.guides.find(g => g.slug === 'home');
        const homeHash = guideBodyHash(homePage);

        const ruDir = path.join(cwd, PKG, 'content/ru/getting-started');
        fs.mkdirSync(ruDir, { recursive: true });
        const page = [
            '---',
            'slug: home',
            'title: Главная',
            'summary: Описание.',
            'related: rules',
            `source-hash: ${homeHash}`,
            '---',
            '',
            'Текст на русском.',
        ].join('\n');
        write(cwd, `${PKG}/content/ru/getting-started/home.md`, page);

        // Also commit generated published copy (violating PR rules for new language)
        const genDir = path.join(cwd, PKG, 'generated');
        fs.mkdirSync(genDir, { recursive: true });
        write(cwd, `${PKG}/generated/guide.ru.json`, JSON.stringify({
            schema: 2, version: 1, language: 'ru', hash: 'abc', sections: [], guides: [],
        }));

        git(cwd, 'add', `${PKG}/content/ru/getting-started/home.md`, `${PKG}/generated/guide.ru.json`);
        git(cwd, 'commit', '-q', '-m', 'add ru and publish');

        const chk = ciCheck(cwd, 'pull_request');
        assert.equal(chk.status, 1, `check should refuse: ${said(chk)}`);
        assert.match(chk.stderr, /this change edits the ru guide's pages.*AND publishes them as v1/);
    } finally {
        repo.cleanup();
    }
});

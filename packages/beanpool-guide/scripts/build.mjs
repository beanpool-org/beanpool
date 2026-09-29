#!/usr/bin/env node
// The members' guide (content/*.md) and the operator manual (operators/*.md) reach the apps as PUBLISHED copies:
//   packages/beanpool-guide/generated/guide.json      — bundled into the member apps
//   apps/website/guide/*.html + guide.json             — the website's member pages, and the copy the apps fetch
//                                                        to pick up a newer guide without an app update
//   packages/beanpool-guide/generated/operators.json  — bundled into the node's Settings (apps/manager)
//   apps/website/guide/operators/*.html + operators.json — the website's copy of the operator manual, ONLY when
//                                                        PUBLISH_OPERATORS_WEBSITE (below) is true. It is false.
//
// The operator manual is not on beanpool.org. Marty's decision, 2026-09-19: the manual ships in node Settings now,
// and the public website copy waits until the security weak spots it describes (the admin password brake's limits,
// among others) are fixed. To publish it later: set PUBLISH_OPERATORS_WEBSITE to true, run
// `pnpm --filter @beanpool/guide generate`, and drop the "does not exist" guards in test/guide.test.mjs and
// apps/manager/src/lib/manual.test.ts. The renderer (renderOperatorsWebsite) is kept and tested in memory.
//
// Versions (Marty's decision, 2026-09-30). An app only replaces its copy of a collection with a HIGHER version, so
// every text change must reach main under a new, higher version — and never the same version with different text.
// Pull requests change only the pages. After merging, the director publishes: `pnpm guide:publish --merge`
// (scripts/publish.mjs) opens a pull request off origin/main that writes the published copies, each collection one
// version higher where its text changed, and merges it. Until then main keeps the last published copy: the old text
// under the old version, which is what every build from main ships. So no build ever carries new text under an old
// version, and two PRs that change the guide never conflict on a version or a generated file.
//
//   node scripts/build.mjs            what an author runs: check the pages, copy the manual's pictures to the
//                                     manager, and re-render the website pages from the published copies (for a
//                                     change to the renderer). Writes no version and no text.
//   node scripts/build.mjs --publish  write the pages' text as the published copies, each collection one version
//                                     higher where its text changed. Only the director's publish runs this.
//   node scripts/build.mjs --check    write nothing; exit 1 if a page does not build, if a generated file is not
//                                     exactly what the published copies produce, or if — compared with the commit
//                                     this change starts from (findBase) — a published copy changed its text without
//                                     a higher version, took a new version for the same text, skipped a version, is
//                                     not the text of the pages, or was published by a change that also edits the
//                                     pages. Run by `pnpm test`, so CI refuses all of these.
//   node scripts/build.mjs --pending  exit 1, naming them, while the pages hold text that is not published yet.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGuide, renderWebsite, renderOperatorsWebsite, serializeGuide, contentHash, GUIDE_SCHEMA } from '../src/guide.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const repoRoot = path.resolve(pkgDir, '../..');
export const CONTENT_DIR = path.join(pkgDir, 'content');
export const BUNDLED_JSON = path.join(pkgDir, 'generated', 'guide.json');
export const WEBSITE_DIR = path.join(repoRoot, 'apps', 'website', 'guide');
export const OPERATORS_DIR = path.join(pkgDir, 'operators');
export const OPERATORS_JSON = path.join(pkgDir, 'generated', 'operators.json');
export const OPERATORS_IMAGES_DIR = path.join(OPERATORS_DIR, 'images');
export const MANAGER_PUBLIC_IMAGES_DIR = path.join(repoRoot, 'apps', 'manager', 'public', 'images');
export const OPERATORS_WEBSITE_DIR = path.join(WEBSITE_DIR, 'operators');
/** Whether the build writes the operator manual to the website. Off: see the header (Marty's decision, 2026-09-19). */
export const PUBLISH_OPERATORS_WEBSITE = false;

/** The two collections: where each one's pages are, and its published copy. */
const COLLECTIONS = [
    { key: 'guide', name: "members' guide", dir: CONTENT_DIR, json: BUNDLED_JSON, load: {} },
    { key: 'manual', name: 'operator manual', dir: OPERATORS_DIR, json: OPERATORS_JSON, load: { aboutSection: null, allowImages: true } },
];
/** What the director's publish writes, as the check's advice spells it: restoring these undoes a publish. */
const PUBLISHED_PATHS = ['packages/beanpool-guide/generated', 'apps/website/guide'];

const rel = file => path.relative(repoRoot, file).split(path.sep).join('/');

/** The pages as they stand, per collection, with no version. Throws on a page that does not build. */
export function sourceGuides() {
    return Object.fromEntries(COLLECTIONS.map(c => [c.key, loadGuide(c.dir, c.load)]));
}

function parsePublished(text, file) {
    try { return JSON.parse(text); } catch (e) { throw new Error(`${rel(file)} is not JSON (${e.message}); restore it from main`); }
}

/** The published copies (the committed generated JSON), per collection; null for one never published. */
export function publishedGuides() {
    return Object.fromEntries(COLLECTIONS.map(c => [c.key, fs.existsSync(c.json) ? parsePublished(fs.readFileSync(c.json, 'utf8'), c.json) : null]));
}

/** Whether two copies of a collection hold the same text in the same schema. Their versions do not count. */
export function sameText(a, b) {
    return a.schema === b.schema && contentHash({ sections: a.sections, guides: a.guides }) === contentHash({ sections: b.sections, guides: b.guides });
}

/** What publishing writes: each collection's pages, one version above its published copy where the text changed. */
export function nextPublished(published, pages) {
    return Object.fromEntries(COLLECTIONS.map(({ key }) => {
        const before = published[key];
        return [key, before && sameText(before, pages[key]) ? before : { ...pages[key], version: (before?.version ?? 0) + 1 }];
    }));
}

/** The collections whose pages hold text their published copy does not, with the version publishing would give. */
export function unpublished(published, pages) {
    const next = nextPublished(published, pages);
    return COLLECTIONS.filter(({ key }) => next[key] !== published[key])
        .map(({ key, name }) => ({ name, from: published[key]?.version ?? null, to: next[key].version }));
}

/** Every generated file (absolute path → exact contents) for these published copies. */
export function outputsFor(published) {
    const out = {};
    for (const c of COLLECTIONS) if (published[c.key]) out[c.json] = serializeGuide(published[c.key]);
    if (published.guide) {
        const websiteOpts = { operatorManualOnWeb: PUBLISH_OPERATORS_WEBSITE };
        for (const [name, text] of Object.entries(renderWebsite(published.guide, websiteOpts))) out[path.join(WEBSITE_DIR, name)] = text;
    }
    if (PUBLISH_OPERATORS_WEBSITE && published.manual) {
        for (const [name, text] of Object.entries(renderOperatorsWebsite(published.manual))) out[path.join(OPERATORS_WEBSITE_DIR, name)] = text;
    }
    return out;
}

/** The published copies, and every file generated from them: what a checkout of main holds. */
export function expectedOutputs() {
    const published = publishedGuides();
    return { guide: published.guide, manual: published.manual, out: outputsFor(published) };
}

// ─── The commit a change starts from ───────────────────────────────────────────

function git(...args) {
    try {
        return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/**
 * The commit this change starts from, whose published copies it is checked against:
 *   GUIDE_BASE=<commit>                    that commit
 *   a branch off origin/main               where it left origin/main (a PR branch, a lane's worktree)
 *   uncommitted guide edits on its tip     the commit under them
 *   otherwise                              the commit before HEAD: on main, main before the last merge; in CI, a pull
 *                                          request is checked out as a merge commit whose first parent is main's tip
 * Returns { ref, why }. ref is null when there is nothing to compare with; `broken` marks the cases the check must
 * not pass over: a shallow clone missing the commit before HEAD (CI fetches it: fetch-depth 2 in ci.yml), or a bad
 * GUIDE_BASE.
 */
export function findBase() {
    const wanted = process.env.GUIDE_BASE;
    if (wanted) {
        const ref = git('rev-parse', '--verify', '--quiet', `${wanted}^{commit}`);
        return ref ? { ref, why: `GUIDE_BASE=${wanted}` } : { ref: null, why: `GUIDE_BASE=${wanted} is not a commit here`, broken: true };
    }
    const head = git('rev-parse', 'HEAD');
    if (!head) return { ref: null, why: 'this is not a git checkout' };
    const forked = git('merge-base', 'HEAD', 'origin/main');
    if (forked && forked !== head) return { ref: forked, why: 'where this branch left origin/main' };
    const guidePaths = [...COLLECTIONS.map(c => rel(c.dir)), ...PUBLISHED_PATHS];
    if (git('status', '--porcelain', '--', ...guidePaths)) return { ref: head, why: 'the commit under these uncommitted edits' };
    const parent = git('rev-parse', '--verify', '--quiet', 'HEAD^1');
    if (parent) return { ref: parent, why: 'the commit before this one' };
    if (git('rev-parse', '--is-shallow-repository') === 'true') {
        return { ref: null, why: 'this shallow clone lacks the commit before HEAD (check out with fetch-depth: 2)', broken: true };
    }
    return { ref: null, why: 'this is the first commit' };
}

function publishedAt(ref, file) {
    const text = git('show', `${ref}:${rel(file)}`);
    return text === null ? null : parsePublished(text, file);
}

/** The pages of a collection this change edits, compared with `ref` (committed or not; the manual's pictures aside). */
function pagesEditedSince(ref, c) {
    const dir = rel(c.dir);
    const lines = s => (s ?? '').split('\n').filter(Boolean);
    return [...lines(git('diff', '--name-only', ref, '--', dir)), ...lines(git('ls-files', '--others', '--exclude-standard', '--', dir))]
        .filter(f => !f.startsWith(`${rel(OPERATORS_IMAGES_DIR)}/`));
}

/** The version rules, as sentences: each published copy against the one at `ref`. */
function versionProblems(published, pages, ref) {
    const problems = [];
    const short = ref.slice(0, 10);
    const restore = `restore main's copy with \`git checkout ${short} -- ${PUBLISHED_PATHS.join(' ')}\` and run \`pnpm --filter @beanpool/guide generate\``;
    for (const c of COLLECTIONS) {
        const before = publishedAt(ref, c.json);
        const now = published[c.key];
        if (!before || !now) continue;
        if (sameText(before, now)) {
            if (now.version !== before.version) {
                problems.push(`${rel(c.json)} carries the same text as v${before.version} under v${now.version}: the same text never ships under two versions; ${restore}`);
            }
            continue;
        }
        // The text changed, so this change publishes the collection.
        if (now.version <= before.version) {
            problems.push(`the ${c.name}'s published text changed but its version is v${now.version}, not above v${before.version}: apps holding v${before.version} would never replace it; ${restore}`);
            continue;
        }
        if (now.version !== before.version + 1) {
            problems.push(`${rel(c.json)} jumps from v${before.version} to v${now.version}; publishing raises a version by one`);
        }
        const edited = pagesEditedSince(ref, c);
        if (edited.length) {
            const named = edited.slice(0, 3).join(', ') + (edited.length > 3 ? ` and ${edited.length - 3} more` : '');
            problems.push(`this change edits the ${c.name}'s pages (${named}) AND publishes them as v${now.version}. A pull request changes only the pages; the director publishes after merge (pnpm guide:publish). So that PRs never conflict on a version, ${restore}`);
        } else if (pages && !sameText(now, pages[c.key])) {
            problems.push(`${rel(c.json)} v${now.version} is not the text of the pages; publish only with pnpm guide:publish, never by hand`);
        }
    }
    return problems;
}

// ─── The check ─────────────────────────────────────────────────────────────────

/** Every file under a folder, as absolute paths. */
function filesUnder(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(d => d.isFile())
        .map(d => path.join(d.parentPath ?? d.path, d.name));
}

function manualImages() {
    return fs.existsSync(OPERATORS_IMAGES_DIR) ? fs.readdirSync(OPERATORS_IMAGES_DIR).filter(img => !img.startsWith('.')) : [];
}

/** Problems with the committed files, as sentences; empty when everything is as it must be. */
export function check({ base = findBase() } = {}) {
    const problems = [];
    let pages = null;
    try {
        pages = sourceGuides();
    } catch (e) {
        problems.push(`the pages do not build: ${e.message}`);
    }
    let published;
    try {
        published = publishedGuides();
    } catch (e) {
        return [...problems, e.message];
    }
    for (const c of COLLECTIONS) {
        const copy = published[c.key];
        if (!copy) {
            problems.push(`${rel(c.json)} is missing: the ${c.name} has never been published (pnpm guide:publish)`);
        } else if (copy.hash !== contentHash({ sections: copy.sections, guides: copy.guides })) {
            problems.push(`${rel(c.json)} was edited by hand: its "hash" does not match its text. Restore it from main`);
        } else if (copy.schema !== GUIDE_SCHEMA) {
            problems.push(`${rel(c.json)} is schema ${copy.schema} but the build writes schema ${GUIDE_SCHEMA}: publish it in the change that bumps the schema (node packages/beanpool-guide/scripts/build.mjs --publish)`);
        }
    }
    const out = outputsFor(published);
    for (const [file, text] of Object.entries(out)) {
        let onDisk = null;
        try { onDisk = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
        if (onDisk === null) problems.push(`${rel(file)} is missing; run pnpm --filter @beanpool/guide generate`);
        else if (onDisk !== text) problems.push(`${rel(file)} does not match the published copy; run pnpm --filter @beanpool/guide generate`);
    }
    for (const file of filesUnder(WEBSITE_DIR)) {
        if (!(file in out)) problems.push(`${rel(file)} is not generated from the published copy; remove it`);
    }
    for (const img of manualImages()) {
        const dst = path.join(MANAGER_PUBLIC_IMAGES_DIR, img);
        if (!fs.existsSync(dst)) {
            problems.push(`apps/manager/public/images/${img} is missing; run generate to copy it`);
        } else if (!fs.readFileSync(path.join(OPERATORS_IMAGES_DIR, img)).equals(fs.readFileSync(dst))) {
            problems.push(`apps/manager/public/images/${img} is out of date; run generate to update it`);
        }
    }
    if (base.broken) problems.push(`cannot compare the published copies with main's: ${base.why}`);
    if (base.ref) problems.push(...versionProblems(published, pages, base.ref));
    return problems;
}

// ─── Writing ───────────────────────────────────────────────────────────────────

function writeOutputs(out) {
    for (const file of filesUnder(WEBSITE_DIR)) {
        if (!(file in out)) fs.rmSync(file);
    }
    for (const [file, text] of Object.entries(out)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    if (manualImages().length) fs.mkdirSync(MANAGER_PUBLIC_IMAGES_DIR, { recursive: true });
    for (const img of manualImages()) fs.copyFileSync(path.join(OPERATORS_IMAGES_DIR, img), path.join(MANAGER_PUBLIC_IMAGES_DIR, img));
}

function pagesOrExit() {
    try {
        return sourceGuides();
    } catch (e) {
        console.error(`The pages do not build: ${e.message}`);
        process.exit(1);
    }
}

/** A sentence on text that waits to be published, or null. */
function pendingNote(waiting) {
    if (!waiting.length) return null;
    const list = waiting.map(w => `the ${w.name} (v${w.from} → v${w.to})`).join(' and ');
    return `Text that waits to be published: ${list}. The director publishes it after merge (pnpm guide:publish); a PR never edits a version or a generated file.`;
}

/** The author's build: check the pages, copy the pictures, re-render the website from the published copies. */
function generate() {
    const pages = pagesOrExit();
    const published = publishedGuides();
    const missing = COLLECTIONS.filter(c => !published[c.key]);
    if (missing.length) {
        console.error(`${missing.map(c => rel(c.json)).join(' and ')} missing: the director publishes first (pnpm guide:publish).`);
        process.exit(1);
    }
    writeOutputs(outputsFor(published));
    console.log(`The pages build. Published: members' guide v${published.guide.version}, operator manual v${published.manual.version}.`);
    const note = pendingNote(unpublished(published, pages));
    if (note) console.log(note);
}

/** The director's publish (run by scripts/publish.mjs): the pages' text as the published copies. */
function publish() {
    const pages = pagesOrExit();
    const published = publishedGuides();
    const next = nextPublished(published, pages);
    writeOutputs(outputsFor(next));
    for (const c of COLLECTIONS) {
        const from = published[c.key]?.version;
        console.log(next[c.key] === published[c.key] ? `The ${c.name} stays v${from}.` : `The ${c.name} v${from ?? 'none'} → v${next[c.key].version}.`);
    }
}

const USAGE = 'Usage: node scripts/build.mjs [--check | --publish | --pending]';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !['--check', '--publish', '--pending'].includes(args[0]))) {
        console.error(USAGE);
        process.exit(2);
    }
    if (args[0] === '--check') {
        const base = findBase();
        const problems = check({ base });
        if (problems.length) {
            console.error('The guide is out of date:\n' + problems.map(p => `  - ${p}`).join('\n'));
            process.exit(1);
        }
        const published = publishedGuides();
        console.log(`Members' guide v${published.guide.version} and operator manual v${published.manual.version}: the pages build and the generated files match the published copies.`);
        console.log(base.ref ? `Versions checked against ${base.ref.slice(0, 10)} (${base.why}).` : `Versions not compared: ${base.why}.`);
        const note = pendingNote(unpublished(published, sourceGuides()));
        if (note) console.log(note);
    } else if (args[0] === '--publish') {
        publish();
    } else if (args[0] === '--pending') {
        const waiting = unpublished(publishedGuides(), pagesOrExit());
        console.log(pendingNote(waiting) ?? 'Nothing waits to be published.');
        process.exit(waiting.length ? 1 : 0);
    } else {
        generate();
    }
}

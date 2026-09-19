#!/usr/bin/env node
// Generate the members' guide from content/*.md and the operator manual from operators/*.md:
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
//   node scripts/build.mjs           write the files
//   node scripts/build.mjs --check   write nothing; exit 1 if any generated file is not exactly what the
//                                    source produces (run by `pnpm test`, so CI fails on a hand edit or a
//                                    forgotten regenerate)
//
// Changing a collection's text means bumping "version" in its manifest.json. The build refuses to write new
// text under an old version number, because an app only replaces its copy with a HIGHER version.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGuide, renderWebsite, renderOperatorsWebsite, serializeGuide } from '../src/guide.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const repoRoot = path.resolve(pkgDir, '../..');
export const CONTENT_DIR = path.join(pkgDir, 'content');
export const BUNDLED_JSON = path.join(pkgDir, 'generated', 'guide.json');
export const WEBSITE_DIR = path.join(repoRoot, 'apps', 'website', 'guide');
export const OPERATORS_DIR = path.join(pkgDir, 'operators');
export const OPERATORS_JSON = path.join(pkgDir, 'generated', 'operators.json');
export const OPERATORS_WEBSITE_DIR = path.join(WEBSITE_DIR, 'operators');
/** Whether the build writes the operator manual to the website. Off: see the header (Marty's decision, 2026-09-19). */
export const PUBLISH_OPERATORS_WEBSITE = false;

/** The two collections: where each is read from, where its bundled JSON goes, and the manifest to bump. */
const COLLECTIONS = [
    { name: "members' guide", manifest: 'content/manifest.json', json: BUNDLED_JSON },
    { name: 'operator manual', manifest: 'operators/manifest.json', json: OPERATORS_JSON },
];

/** Every generated file (absolute path → exact contents) for the current source. */
export function expectedOutputs() {
    const guide = loadGuide(CONTENT_DIR);
    const manual = loadGuide(OPERATORS_DIR, { aboutSection: null });
    const out = { [BUNDLED_JSON]: serializeGuide(guide), [OPERATORS_JSON]: serializeGuide(manual) };
    const websiteOpts = { operatorManualOnWeb: PUBLISH_OPERATORS_WEBSITE };
    for (const [name, text] of Object.entries(renderWebsite(guide, websiteOpts))) out[path.join(WEBSITE_DIR, name)] = text;
    if (PUBLISH_OPERATORS_WEBSITE) {
        for (const [name, text] of Object.entries(renderOperatorsWebsite(manual))) out[path.join(OPERATORS_WEBSITE_DIR, name)] = text;
    }
    return { guide, manual, out };
}

function previous(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Collections whose text changed without a version bump, as sentences. */
function versionProblems(guide, manual) {
    const problems = [];
    for (const [c, now] of [[COLLECTIONS[0], guide], [COLLECTIONS[1], manual]]) {
        const prev = previous(c.json);
        if (prev && prev.hash !== now.hash && prev.version >= now.version) {
            problems.push(`the ${c.name} text changed but ${c.manifest} "version" is still ${now.version}; raise it to ${prev.version + 1}`);
        }
    }
    return problems;
}

/** Every file under a folder, as absolute paths. */
function filesUnder(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(d => d.isFile())
        .map(d => path.join(d.parentPath ?? d.path, d.name));
}

/** Problems with the committed files, as sentences; empty when everything matches the source. */
export function check() {
    const { guide, manual, out } = expectedOutputs();
    const problems = versionProblems(guide, manual);
    for (const [file, text] of Object.entries(out)) {
        const rel = path.relative(repoRoot, file);
        let onDisk = null;
        try { onDisk = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
        if (onDisk === null) problems.push(`${rel} is missing`);
        else if (onDisk !== text) problems.push(`${rel} does not match the source`);
    }
    for (const file of filesUnder(WEBSITE_DIR)) {
        if (!(file in out)) problems.push(`${path.relative(repoRoot, file)} is not generated from the source; remove it`);
    }
    return problems;
}

function write() {
    const { guide, manual, out } = expectedOutputs();
    const problems = versionProblems(guide, manual);
    if (problems.length) {
        console.error(problems.map(p => `${p[0].toUpperCase()}${p.slice(1)}.`).join('\n') + '\nThen run this again.');
        process.exit(1);
    }
    for (const file of filesUnder(WEBSITE_DIR)) {
        if (!(file in out)) fs.rmSync(file);
    }
    for (const [file, text] of Object.entries(out)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    console.log(`Members' guide v${guide.version}, operator manual v${manual.version}: wrote ${Object.keys(out).length} files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--check')) {
        const problems = check();
        if (problems.length) {
            console.error('The guide is out of date:\n' + problems.map(p => `  - ${p}`).join('\n') +
                '\nRun: pnpm --filter @beanpool/guide generate');
            process.exit(1);
        }
        console.log("Members' guide and operator manual: generated files match the source.");
    } else {
        write();
    }
}

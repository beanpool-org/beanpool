#!/usr/bin/env node
// Generate the members' guide from content/*.md:
//   packages/beanpool-guide/generated/guide.json   — bundled into the native app
//   apps/website/guide/*.html + guide.json          — the website's member pages, and the copy the app
//                                                     fetches to pick up a newer guide without an app update
//
//   node scripts/build.mjs           write the files
//   node scripts/build.mjs --check   write nothing; exit 1 if any generated file is not exactly what the
//                                    source produces (run by `pnpm test`, so CI fails on a hand edit or a
//                                    forgotten regenerate)
//
// Changing the guide text means bumping "version" in content/manifest.json. The build refuses to write new
// text under an old version number, because the app only replaces its copy with a HIGHER version.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGuide, renderWebsite, serializeGuide } from '../src/guide.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const repoRoot = path.resolve(pkgDir, '../..');
export const CONTENT_DIR = path.join(pkgDir, 'content');
export const BUNDLED_JSON = path.join(pkgDir, 'generated', 'guide.json');
export const WEBSITE_DIR = path.join(repoRoot, 'apps', 'website', 'guide');

/** Every generated file (absolute path → exact contents) for the current source. */
export function expectedOutputs() {
    const guide = loadGuide(CONTENT_DIR);
    const out = { [BUNDLED_JSON]: serializeGuide(guide) };
    for (const [name, text] of Object.entries(renderWebsite(guide))) out[path.join(WEBSITE_DIR, name)] = text;
    return { guide, out };
}

function previousGuide() {
    try { return JSON.parse(fs.readFileSync(BUNDLED_JSON, 'utf8')); } catch { return null; }
}

/** Problems with the committed files, as sentences; empty when everything matches the source. */
export function check() {
    const { guide, out } = expectedOutputs();
    const problems = [];
    const prev = previousGuide();
    if (prev && prev.hash !== guide.hash && prev.version >= guide.version) {
        problems.push(`the guide text changed but content/manifest.json "version" is still ${guide.version}; raise it to ${prev.version + 1}`);
    }
    for (const [file, text] of Object.entries(out)) {
        const rel = path.relative(repoRoot, file);
        let onDisk = null;
        try { onDisk = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
        if (onDisk === null) problems.push(`${rel} is missing`);
        else if (onDisk !== text) problems.push(`${rel} does not match the source`);
    }
    const expectedNames = new Set(Object.keys(out).filter(f => path.dirname(f) === WEBSITE_DIR).map(f => path.basename(f)));
    if (fs.existsSync(WEBSITE_DIR)) {
        for (const name of fs.readdirSync(WEBSITE_DIR)) {
            if (!expectedNames.has(name)) problems.push(`apps/website/guide/${name} is not generated from the source; remove it`);
        }
    }
    return problems;
}

function write() {
    const { guide, out } = expectedOutputs();
    const prev = previousGuide();
    if (prev && prev.hash !== guide.hash && prev.version >= guide.version) {
        console.error(`The guide text changed. Raise "version" in packages/beanpool-guide/content/manifest.json to ${prev.version + 1}, then run this again.`);
        process.exit(1);
    }
    fs.mkdirSync(WEBSITE_DIR, { recursive: true });
    const keep = new Set(Object.keys(out));
    for (const name of fs.readdirSync(WEBSITE_DIR)) {
        const file = path.join(WEBSITE_DIR, name);
        if (!keep.has(file)) fs.rmSync(file);
    }
    for (const [file, text] of Object.entries(out)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }
    console.log(`Members' guide v${guide.version}: wrote ${Object.keys(out).length} files.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--check')) {
        const problems = check();
        if (problems.length) {
            console.error("The members' guide is out of date:\n" + problems.map(p => `  - ${p}`).join('\n') +
                '\nRun: pnpm --filter @beanpool/guide generate');
            process.exit(1);
        }
        console.log("Members' guide: generated files match the source.");
    } else {
        write();
    }
}

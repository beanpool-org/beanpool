#!/usr/bin/env node
/**
 * One chunk per tool, on the real build output (scratch/tools/DESIGN-tool-template-fable.md §2.3 step 6, §2.4; slice T0.3).
 *
 * This builds the web app with its own vite config and, beside the tools the registry ships (the Tool shed since T1.3),
 * the scaffold registered as a tool under TOOL_ID, as `node scripts/tools/new-tool.mjs <id>` would write it, without
 * touching the tree: a plugin serves the scaffold's web half at apps/pwa/src/tools/<id>/ and src/tools/index.ts with its
 * one line added (scripts/tools/registry.mjs registerIn). Then it reads what came out:
 *   - exactly one `tool-<id>` chunk for the scaffold and for each tool the registry ships, and none for any other id;
 *   - the scaffold's chunk holds its screens (a sentence only they draw), and only what is the tool's own (a few KB:
 *     React, core and the primitives stay where the app has them); no other file holds that sentence;
 *   - no file imports a tool's chunk statically: the first chunk and the Tools page load a tool only when it is opened
 *     (`import()`);
 *   - the Tools page is its own chunk too, and the first chunk holds none of its sentences.
 * It prints the sizes: the first chunk (raw and gzipped), the Tools page chunk and each tool's chunk.
 *
 * Run:  pnpm --filter @beanpool/pwa tool-chunks-check   (needs @beanpool/core built; it builds nothing else)
 *   TOOL_CHUNKS_DIR=<dir>   read an existing build output instead of building (it must have been built with the scaffold)
 *   TOOL_ID=<id>            the id to register the scaffold under (default demo)
 */
/* global console, process -- Node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const PWA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(PWA, '../..');
const ID = process.env.TOOL_ID || 'demo';
const { PARTS, readRegistry, registerIn, scaffoldFiles } = await import(pathToFileURL(path.join(REPO, 'scripts/tools/registry.mjs')).href);
const web = PARTS.find((p) => p.part === 'pwa');
/** The tools the web registry ships, each its own chunk too. */
const shipped = readRegistry(web, fs.readFileSync(path.join(REPO, web.index), 'utf8')).entries.map((e) => e.id);
if (shipped.includes(ID)) throw new Error(`TOOL_ID ${ID} is a tool the registry ships: pick another id for the scaffold`);

/** Files the build sees that the tree hasn't got: the scaffold's web half, and the registry with its line. */
const overlay = new Map();
for (const f of scaffoldFiles(ID).filter((x) => x.part === 'pwa')) overlay.set(path.join(REPO, web.dir, f.rel), f.text);
const index = path.join(REPO, web.index);
overlay.set(index, registerIn(web, fs.readFileSync(index, 'utf8'), ID));
/** A sentence only the scaffold's screens draw: where it lands is where the tool's code is. */
const MARK = 'Kept here: {count}';
const screens = [...overlay].find(([file]) => file.endsWith(`${path.sep}screens.tsx`));
if (!screens || !screens[1].includes(`'${MARK}'`)) throw new Error(`the scaffold's screens no longer draw '${MARK}': pick another mark`);

function scaffoldRegistered() {
    const candidates = (p) => [p, `${p}.ts`, `${p}.tsx`, path.join(p, 'index.ts'), path.join(p, 'index.tsx')];
    return {
        name: 'beanpool-tool-chunks-scaffold',
        enforce: 'pre',
        resolveId(source, importer) {
            if (!importer || !source.startsWith('.')) return null;
            const base = path.resolve(path.dirname(importer.split('?')[0]), source);
            return candidates(base).find((c) => overlay.has(c) && c !== index) ?? null;
        },
        load(id) {
            const file = id.split('?')[0];
            return overlay.has(file) ? overlay.get(file) : null;
        },
    };
}

let out = process.env.TOOL_CHUNKS_DIR;
if (!out) {
    out = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tool-chunks-'));
    process.chdir(PWA); // Tailwind reads its content paths from here
    await build({
        root: PWA, configFile: path.join(PWA, 'vite.config.ts'), logLevel: 'error',
        plugins: [scaffoldRegistered()],
        build: { outDir: out, emptyOutDir: true },
    });
}
const assets = path.join(out, 'assets');
const js = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(assets, f), 'utf8');
const size = (f) => fs.statSync(path.join(assets, f)).size;
const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(assets, f))).length;

const problems = [];
const toolChunks = js.filter((f) => /^tool-[a-z]+(?:-[a-z]+)*-[A-Za-z0-9_-]{8}\.js$/.test(f));
const chunkOf = (id) => toolChunks.filter((f) => f.startsWith(`tool-${id}-`) && /^[A-Za-z0-9_-]{8}\.js$/.test(f.slice(`tool-${id}-`.length)));
const mine = chunkOf(ID);
if (mine.length !== 1) problems.push(`${mine.length} tool-${ID} chunks (${mine.join(', ') || 'none'}): exactly one is wanted`);
const theirs = shipped.flatMap((id) => {
    const c = chunkOf(id);
    if (c.length !== 1) problems.push(`${c.length} tool-${id} chunks (${c.join(', ') || 'none'}): exactly one is wanted for a tool the registry ships`);
    return c;
});
for (const f of toolChunks) if (!mine.includes(f) && !theirs.includes(f)) problems.push(`${f}: a tool chunk for a tool that isn't registered`);
if (mine.length === 1 && !read(mine[0]).includes(MARK)) problems.push(`${mine[0]}: the tool's screens are not in its chunk`);
for (const f of js) if (!mine.includes(f) && read(f).includes(MARK)) problems.push(`${f}: holds the tool's screens, outside its chunk`);
// Loaded only when opened: no chunk imports the tool's statically (`from"./tool-…"`, `import"./tool-…"`); only `import("./tool-…")`.
for (const f of js) {
    for (const t of [...mine, ...theirs]) {
        if (f === t) continue;
        const name = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?:from|import)\\s*["']\\./${name}["']`).test(read(f))) problems.push(`${f}: imports ${t} statically, so it loads at start`);
    }
}
// What the tool's chunk holds is the tool's own: React, core and the template's primitives stay where the app has them.
if (mine.length === 1 && size(mine[0]) > 20_000) problems.push(`${mine[0]}: ${size(mine[0])} bytes for the scaffold's one screen: shared code was pulled into it`);

// The first chunk is the one index.html loads.
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const entry = /src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
if (!entry || !js.includes(entry)) problems.push(`index.html names no first chunk (${entry ?? 'none'})`);
const page = js.find((f) => f !== entry && read(f).includes('tools-page'));
if (!page) problems.push('no chunk holds the Tools page (data-testid "tools-page")');
if (entry && read(entry).includes('tools-page')) problems.push(`${entry}: the first chunk holds the Tools page, which should load only when opened`);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
if (entry) console.log(`first chunk ${entry}: ${kb(size(entry))} raw, ${kb(gz(entry))} gzipped`);
if (page) console.log(`Tools page chunk ${page}: ${kb(size(page))} raw, ${kb(gz(page))} gzipped`);
for (const f of [...mine, ...theirs]) console.log(`tool chunk ${f}: ${kb(size(f))} raw, ${kb(gz(f))} gzipped`);
console.log(`${js.length} js files read in ${out}`);
if (problems.length) {
    for (const p of problems) console.log(`FAIL ${p}`);
    process.exit(1);
}
console.log(`tool-chunks-check: ok — the scaffold (${ID})${shipped.map((id) => ` and ${id}`).join('')}: each one chunk of its own, loaded only when opened, and the Tools page is another`);

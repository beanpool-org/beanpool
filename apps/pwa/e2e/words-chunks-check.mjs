#!/usr/bin/env node
/**
 * One chunk per language, on the real build output (design §2.4, §7 S2; #1941 review N-f).
 *
 * Builds the web app with its own vite config into a scratch folder and reads what came out:
 *   - exactly one `words-<lang>` chunk for each of core's LANGS but English, and no other `words-` chunk;
 *   - each holds its language's three parts: this app's catalog and core's (their `_meta.language`), and core's date
 *     words (that language's month names, as words-dates/<lang>.ts writes them);
 *   - no other file of the build holds any language's month names or catalog: the first chunk is English alone, and a
 *     visitor downloads only the language they read.
 *
 * Run:  pnpm --filter @beanpool/pwa words-chunks-check   (needs @beanpool/core built; it builds nothing else)
 *   WORDS_CHUNKS_DIR=<dir>  read an existing build output instead of building (a fail-first on another commit)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const PWA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.resolve(PWA, '../../packages/beanpool-core');

const { LANGS } = await import(pathToFileURL(path.join(CORE, 'dist/words.js')).href);
const others = LANGS.filter((l) => l !== 'en');

let out = process.env.WORDS_CHUNKS_DIR;
if (!out) {
    out = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'words-chunks-'));
    process.chdir(PWA); // Tailwind reads its content paths from here
    await build({ root: PWA, configFile: path.join(PWA, 'vite.config.ts'), logLevel: 'error', build: { outDir: out, emptyOutDir: true } });
}
const assets = path.join(out, 'assets');
const js = fs.readdirSync(assets).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(assets, f), 'utf8');

const problems = [];
const chunkOf = new Map();
for (const f of js) {
    const m = /^words-([A-Za-z-]+?)-[A-Za-z0-9_-]{8}\.js$/.exec(f);
    if (!m) continue;
    if (!others.includes(m[1])) problems.push(`${f}: a words- chunk for "${m[1]}", which is not one of LANGS but English`);
    else if (chunkOf.has(m[1])) problems.push(`${m[1]}: two chunks (${chunkOf.get(m[1])}, ${f})`);
    else chunkOf.set(m[1], f);
}

/**
 * A language's date words as they appear in the minified chunk: one of its tables as JSON (the minifier keeps double
 * quotes), the first that no other language shares (ja, zh-Hans and zh-Hant all write months as "1"–"12").
 */
const FIELDS = ['monthsLong', 'daysShort', 'monthsShort', 'daysLong', 'monthsStandalone'];
const tables = Object.fromEntries(await Promise.all(others.map(async (l) => {
    const { dateWords } = await import(pathToFileURL(path.join(CORE, `dist/words-dates/${l}.js`)).href);
    return [l, dateWords];
})));
function markerOf(lang) {
    for (const field of FIELDS) {
        const mine = JSON.stringify(tables[lang][field]);
        if (others.every((o) => o === lang || JSON.stringify(tables[o][field]) !== mine)) return mine;
    }
    throw new Error(`${lang}: no date table of its own to look for`);
}
const metaMark = (lang) => new RegExp(`language:\\s*"${lang.replace('-', '\\-')}"|"language":\\s*"${lang.replace('-', '\\-')}"`, 'g');

const months = Object.fromEntries(others.map((l) => [l, markerOf(l)]));
for (const lang of others) {
    const f = chunkOf.get(lang);
    if (!f) { problems.push(`${lang}: no words-${lang} chunk`); continue; }
    const text = read(f);
    if (!text.includes(months[lang])) problems.push(`${f}: ${lang}'s date words are not in its chunk`);
    const metas = text.match(metaMark(lang)) ?? [];
    if (metas.length < 2) problems.push(`${f}: ${metas.length} of 2 catalogs (this app's and core's) carry _meta.language "${lang}"`);
}
// Nowhere else: not in the first chunk, not in another language's chunk (zh-Hans and zh-Hant share no table either).
for (const f of js) {
    const text = read(f);
    for (const lang of others) {
        if (chunkOf.get(lang) === f) continue;
        if (text.includes(months[lang])) problems.push(`${f}: holds ${lang}'s date words`);
        if (metaMark(lang).test(text)) problems.push(`${f}: holds a ${lang} catalog`);
    }
}

const sizes = [...chunkOf.values()].map((f) => fs.statSync(path.join(assets, f)).size);
console.log(`words chunks: ${chunkOf.size} of ${others.length} languages, ${Math.min(...sizes)}–${Math.max(...sizes)} bytes each; ${js.length} js files read in ${out}`);
if (problems.length) {
    for (const p of problems) console.log(`FAIL ${p}`);
    process.exit(1);
}
console.log('words-chunks-check: ok — one chunk per language, each with its two catalogs and its dates, and none elsewhere');

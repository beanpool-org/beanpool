#!/usr/bin/env node
// measure-tab-words.mjs — writes apps/native/utils/__tests__/tab-word-widths.json: the width of every tab-strip word in
// hi, bn, ta and ml as Android draws it, which tab-bar-words-render.test.ts holds to 0.8 of the label at 320 dp.
//
//   node scripts/words/measure-tab-words.mjs                  fetch the fonts, measure, write (run it by hand; committed)
//   node scripts/words/measure-tab-words.mjs --fonts <dir>    use fonts already in <dir> (the file names below)
//
// Why measured: the test's width model (0.62 em a letter, nothing for a combining mark) counts these scripts 1.03–4.9×
// too narrow (#2152 deciding review; ml "ഹോം" is one wide cluster of three code points, a Tamil letter is near an em),
// and no per-letter em is both safe and close: conjuncts fold several code points into one glyph. So each word is
// shaped with HarfBuzz (`hb-shape`, the shaper under Android's text; brew install harfbuzz) in Noto Sans <script> Bold
// (the label is bold) and in its UI variant (Android's default, compact text), and the wider of the two is kept, in em.
// A tab word changed in one of these catalogs has no width until this is run again, and the test says so.
//
// Fonts at pinned commits: Noto Sans <script> from notofonts.github.io, the UI variants from the noto-fonts archive.
// PROBES are words the test uses to show the model let through what the font draws below 0.8 (the review's examples).

/* global process, fetch, Buffer, console */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = 'apps/native/utils/__tests__/tab-word-widths.json';
const STRIP = ['Home', 'Market', 'Map', 'Talk', 'Commons', 'Ledger'];
const FAMILY = { hi: 'Devanagari', bn: 'Bengali', ta: 'Tamil', ml: 'Malayalam' };
const PROBES = { ta: ['பேரேட்டுக்கணக்கு', 'பொதுச்சொத்து'], ml: ['കണക്കുപുസ്തകം'] };
const CDN = 'https://cdn.jsdelivr.net/gh/notofonts';
const fontFiles = (family) => [
    [`NotoSans${family}-Bold.ttf`, `${CDN}/notofonts.github.io@9566151bf4d9138cd83d3563196fb2efa5698eaa/fonts/NotoSans${family}/hinted/ttf/NotoSans${family}-Bold.ttf`],
    [`NotoSans${family}UI-Bold.ttf`, `${CDN}/noto-fonts@ffebf8c1ee449e544955a7e813c54f9b73848eac/hinted/ttf/NotoSans${family}UI/NotoSans${family}UI-Bold.ttf`],
];

const at = process.argv.indexOf('--fonts');
const fontDir = at > 0 ? path.resolve(process.argv[at + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'tab-fonts-'));
for (const family of Object.values(FAMILY)) {
    for (const [file, url] of fontFiles(family)) {
        if (fs.existsSync(path.join(fontDir, file))) continue;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: ${res.status}`);
        fs.writeFileSync(path.join(fontDir, file), Buffer.from(await res.arrayBuffer()));
    }
}

/** The advance of the shaped text in em (Noto's 1000 units an em), the wider of the font and its UI variant. */
function emOf(family, text) {
    return Math.max(...fontFiles(family).map(([file]) => {
        const glyphs = JSON.parse(execFileSync('hb-shape', ['--output-format=json', '--no-glyph-names', path.join(fontDir, file), text], { encoding: 'utf8' }));
        return glyphs.reduce((w, g) => w + g.ax, 0) / 1000;
    }));
}

const widths = {};
const probes = {};
for (const [lang, family] of Object.entries(FAMILY)) {
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/native/words', `${lang}.json`), 'utf8'));
    widths[lang] = {};
    for (const english of STRIP) {
        const word = catalog[`${english}\u0004tab`];
        if (typeof word === 'string') widths[lang][word] = Number(emOf(family, word).toFixed(3));
    }
    for (const word of PROBES[lang] ?? []) (probes[lang] ??= {})[word] = Number(emOf(family, word).toFixed(3));
}
const harfbuzz = execFileSync('hb-shape', ['--version'], { encoding: 'utf8' }).split('\n')[0];
fs.writeFileSync(path.join(ROOT, OUT), `${JSON.stringify({
    about: 'Tab-strip words in em, shaped by HarfBuzz in Noto Sans <script> Bold and its UI variant (the wider). Written by scripts/words/measure-tab-words.mjs.',
    harfbuzz,
    widths,
    probes,
}, null, 2)}\n`);
console.log(`measure-tab-words — wrote ${OUT}: ${Object.values(widths).reduce((n, w) => n + Object.keys(w).length, 0)} words (${harfbuzz})`);
